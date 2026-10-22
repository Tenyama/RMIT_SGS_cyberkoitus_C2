import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getChangeRequest, listChangeRequests, trackChangeRequest, _resetIgaCache } from '../src/iga.ts';

const BASE = 'http://kc.test';
const ADMIN = `${BASE}/admin/realms/test1`;
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let pending: unknown[];

beforeEach(() => {
  process.env.TIDECLOAK_URL = BASE;
  delete process.env.REALM;
  process.env.SA_CLIENT_SECRET = 's3cret';
  _resetIgaCache();
  pending = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === `${BASE}/realms/test1/protocol/openid-connect/token`) return json(200, { access_token: 'sa-1', expires_in: 60 });
    if (url === `${ADMIN}/iga/change-requests?status=PENDING`) return json(200, pending);
    if (url === `${ADMIN}/iga/change-requests/cr-tracked`)
      return json(200, { id: 'cr-tracked', status: 'PENDING', entityType: 'USER', entityId: 'sa-user', actionType: 'GRANT_ROLES', authorizationCount: 0, threshold: 1, createdAt: 100 });
    return json(404, { error: 'not found ' + url });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('friendly change-request naming', () => {
  it('tracked CR (exception request) gets a title, plain-language summary and po_id', async () => {
    trackChangeRequest('cr-tracked', 'PO-ab12cd34', 'agent-planner');
    const cr = await getChangeRequest('cr-tracked');
    expect(cr.title).toBe('Exception request · PO-ab12cd34');
    expect(cr.summary).toMatch(/agent-planner/);
    expect(cr.summary).toMatch(/PO-ab12cd34/);
    expect(cr.summary).toMatch(/once/i);
    expect(cr.po_id).toBe('PO-ab12cd34');
  });

  it('untracked CRs still get a readable title instead of a raw dump', async () => {
    pending = [
      { id: 'cr-grant', status: 'PENDING', entityType: 'USER', entityId: 'u-1', actionType: 'GRANT_ROLES', authorizationCount: 0, threshold: 1, createdAt: 100 },
      { id: 'cr-revoke', status: 'PENDING', entityType: 'USER', entityId: 'u-2', actionType: 'REVOKE_ROLES', authorizationCount: 0, threshold: 1, createdAt: 200 },
    ];
    const [grant, revoke] = await listChangeRequests();
    expect(grant.title).toBe('Grant role (USER)');
    expect(revoke.title).toBe('Revoke role (USER)');
    expect(grant.po_id).toBeNull();
  });
});
