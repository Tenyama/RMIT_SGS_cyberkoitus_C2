import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { openExceptionRequest, getChangeRequest, listChangeRequests, getSaToken, IgaError, registerIgaRoutes, _resetIgaCache, poIdFor } from '../src/iga.ts';

const BASE = 'http://kc.test';
const ADMIN = `${BASE}/admin/realms/test1`;
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let calls: { url: string; init: RequestInit }[];
let grant: () => Response;
let held: { name: string }[];
let pending: unknown[];

beforeEach(() => {
  process.env.TIDECLOAK_URL = BASE;
  delete process.env.REALM; // default must be test1
  process.env.SA_CLIENT_SECRET = 's3cret';
  _resetIgaCache();
  calls = [];
  held = [{ name: 'agent.planner' }];
  pending = [];
  grant = () => json(202, { status: 'PENDING', changeRequestId: 'cr-42' });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${BASE}/realms/test1/protocol/openid-connect/token`) return json(200, { access_token: `sa-${calls.length}`, expires_in: 60 });
    if (url === `${ADMIN}/clients?clientId=agent-planner`) return json(200, [{ id: 'client-uuid', clientId: 'agent-planner' }]);
    if (url === `${ADMIN}/clients?clientId=ghost`) return json(200, []);
    if (url === `${ADMIN}/clients/client-uuid/service-account-user`) return json(200, { id: 'sa-user' });
    if (url === `${ADMIN}/roles/proc.exception-submit`) return json(200, { id: 'role-x', name: 'proc.exception-submit' });
    if (url === `${ADMIN}/users/sa-user/role-mappings/realm`) return init.method === 'POST' ? grant() : json(200, held);
    if (url === `${ADMIN}/iga/change-requests?status=PENDING`) return json(200, pending);
    if (url === `${ADMIN}/iga/change-requests/cr-1`)
      return json(200, { id: 'cr-1', status: 'APPROVED', entityType: 'USER', entityId: 'sa-user', actionType: 'GRANT_ROLES', rows: [], authorizationCount: 1, threshold: 1, readyToCommit: false, createdAt: 100, resolvedAt: 200 });
    if (url === `${ADMIN}/iga/change-requests/gone`) return json(404, { error: 'not found' });
    return json(500, { error: 'unmocked ' + url });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('openExceptionRequest', () => {
  it('202 with id → returns it, posts the role rep to the SA user, tracks po', async () => {
    expect(await openExceptionRequest('po-1', 'agent-planner')).toEqual({ change_request_id: 'cr-42' });
    const post = calls.find((c) => c.init.method === 'POST' && c.url.includes('role-mappings'))!;
    expect(JSON.parse(String(post.init.body))).toEqual([{ id: 'role-x', name: 'proc.exception-submit' }]);
    expect((post.init.headers as Record<string, string>).Authorization).toMatch(/^Bearer sa-/);
    expect(poIdFor('cr-42')).toBe('po-1');
  });

  it('204 → newest PENDING GRANT_ROLES CR for that SA user', async () => {
    grant = () => json(204);
    pending = [
      { id: 'cr-other-user', entityId: 'u2', actionType: 'GRANT_ROLES', createdAt: 900 },
      { id: 'cr-revoke', entityId: 'sa-user', actionType: 'REVOKE_ROLES', createdAt: 800 },
      { id: 'cr-old', entityId: 'sa-user', actionType: 'GRANT_ROLES', createdAt: 100 },
      { id: 'cr-new', entityId: 'sa-user', actionType: 'GRANT_ROLES', createdAt: 500 },
    ];
    expect(await openExceptionRequest('po-2', 'agent-planner')).toEqual({ change_request_id: 'cr-new' });
    expect(poIdFor('cr-new')).toBe('po-2');
  });

  it('202 without id → lookup too', async () => {
    grant = () => json(202, {});
    pending = [{ id: 'cr-9', entityId: 'sa-user', actionType: 'GRANT_ROLES', createdAt: 1 }];
    expect(await openExceptionRequest('po-3', 'agent-planner')).toEqual({ change_request_id: 'cr-9' });
  });

  it('2xx but no CR anywhere → UNEXPECTED', async () => {
    grant = () => json(204);
    await expect(openExceptionRequest('po-3', 'agent-planner')).rejects.toMatchObject({ code: 'UNEXPECTED' });
  });

  it('role already held → ROLE_STILL_GRANTED without POSTing', async () => {
    held = [{ name: 'proc.exception-submit' }];
    const err = await openExceptionRequest('po-4', 'agent-planner').catch((e) => e);
    expect(err).toBeInstanceOf(IgaError);
    expect(err.code).toBe('ROLE_STILL_GRANTED');
    expect(calls.some((c) => c.init.method === 'POST' && c.url.includes('role-mappings'))).toBe(false);
  });

  it('unknown client → ENTITY_VANISHED', async () => {
    await expect(openExceptionRequest('po-5', 'ghost')).rejects.toMatchObject({ code: 'ENTITY_VANISHED' });
  });

  it.each([
    [403, 'FORBIDDEN'],
    [409, 'CONFLICT'],
    [412, 'QUORUM_NOT_MET'],
    [404, 'ENTITY_VANISHED'],
    [500, 'UNEXPECTED'],
  ] as const)('%i → IgaError %s', async (status, code) => {
    grant = () => json(status, { error: 'Resolve or deny it before requesting this change' });
    const err = await openExceptionRequest('po-6', 'agent-planner').catch((e) => e);
    expect(err).toBeInstanceOf(IgaError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });
});

describe('getChangeRequest / listChangeRequests', () => {
  it('maps authorizationCount/threshold', async () => {
    expect(await getChangeRequest('cr-1')).toEqual({ id: 'cr-1', status: 'APPROVED', summary: expect.stringContaining('GRANT_ROLES'), approvals: 1, required: 1, updated_at: 200 });
  });

  it('404 → ENTITY_VANISHED', async () => {
    await expect(getChangeRequest('gone')).rejects.toMatchObject({ code: 'ENTITY_VANISHED' });
  });

  it('list defaults to status=PENDING', async () => {
    pending = [{ id: 'cr-p', status: 'PENDING', authorizationCount: 0, threshold: 2, createdAt: 5 }];
    expect((await listChangeRequests())[0]).toMatchObject({ id: 'cr-p', approvals: 0, required: 2 });
    expect(calls.at(-1)!.url).toBe(`${ADMIN}/iga/change-requests?status=PENDING`);
  });

  it('caches SA token', async () => {
    await getSaToken();
    await getSaToken();
    expect(calls.filter((c) => c.url.endsWith('/openid-connect/token'))).toHaveLength(1);
    expect(String(calls[0].init.body)).toContain('client_id=tidewatch-sa');
  });
});

describe('GET /api/change-requests', () => {
  it('returns items with po_id; 403 without approver role', async () => {
    await openExceptionRequest('po-1', 'agent-planner');
    pending = [{ id: 'cr-42', status: 'PENDING', authorizationCount: 0, threshold: 1, createdAt: 1 }, { id: 'cr-x', status: 'PENDING' }];
    const app = new Hono<{ Variables: { roles: string[] } }>();
    app.use('*', async (c, next) => { c.set('roles', ['tide-realm-admin']); await next(); });
    registerIgaRoutes(app);
    const ok = await app.request('/api/change-requests');
    expect(ok.status).toBe(200);
    const { items } = await ok.json();
    expect(items.map((i: { id: string; po_id: string | null }) => [i.id, i.po_id])).toEqual([['cr-42', 'po-1'], ['cr-x', null]]);

    const guarded = new Hono<{ Variables: { roles: string[] } }>();
    guarded.use('*', async (c, next) => { c.set('roles', ['proc.buyer']); await next(); });
    registerIgaRoutes(guarded);
    expect((await guarded.request('/api/change-requests')).status).toBe(403);
  });
});
