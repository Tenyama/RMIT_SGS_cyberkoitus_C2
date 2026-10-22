import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { revokeRole, listChangeRequests, getSaToken, IgaError, registerIgaRoutes, _resetIgaCache } from '../src/iga.ts';

const BASE = 'http://kc.test';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let calls: { url: string; init: RequestInit }[];
let deleteHandler: Handler;
let listBody: unknown[];

function installFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/realms/tidewatch/protocol/openid-connect/token')) {
      return json(200, { access_token: `sa-${calls.length}`, expires_in: 60 });
    }
    if (url.endsWith('/admin/realms/tidewatch/roles/_tide_kyc.selfdecrypt')) {
      return json(200, { id: 'role-1', name: '_tide_kyc.selfdecrypt', composite: false, clientRole: false });
    }
    if (url.includes('/role-mappings/realm') && init.method === 'DELETE') return deleteHandler(url, init);
    if (url.includes('/iga/change-requests')) return json(200, listBody);
    return json(500, { error: 'unmocked ' + url });
  }));
}

beforeEach(() => {
  process.env.TIDECLOAK_URL = BASE;
  process.env.REALM = 'tidewatch';
  process.env.SA_CLIENT_ID = 'tidewatch-sa';
  process.env.SA_CLIENT_SECRET = 's3cret';
  _resetIgaCache();
  listBody = [];
  deleteHandler = () => json(202, { status: 'PENDING', changeRequestId: 'cr-42', entityType: 'USER_ROLE', actionType: 'REVOKE' });
  installFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('iga.revokeRole', () => {
  it('202 → returns change_request_id from body and sends role rep', async () => {
    const res = await revokeRole('user-1', '_tide_kyc.selfdecrypt');
    expect(res).toEqual({ change_request_id: 'cr-42' });
    const del = calls.find((c) => c.init.method === 'DELETE')!;
    expect(del.url).toBe(`${BASE}/admin/realms/tidewatch/users/user-1/role-mappings/realm`);
    expect(JSON.parse(String(del.init.body))).toEqual([expect.objectContaining({ id: 'role-1', name: '_tide_kyc.selfdecrypt' })]);
    expect((del.init.headers as Record<string, string>).Authorization).toMatch(/^Bearer sa-/);
  });

  it('202 without body id → falls back to Location header', async () => {
    deleteHandler = () => json(202, {}, { Location: `${BASE}/admin/realms/tidewatch/iga/change-requests/cr-loc` });
    expect(await revokeRole('user-1', '_tide_kyc.selfdecrypt')).toEqual({ change_request_id: 'cr-loc' });
  });

  it('202 without id or Location → newest PENDING CR for that user', async () => {
    deleteHandler = () => json(202, undefined);
    listBody = [
      { id: 'cr-other', status: 'PENDING', entityId: 'user-2', createdAt: 300 },
      { id: 'cr-old', status: 'PENDING', entityId: 'user-1', createdAt: 100 },
      { id: 'cr-new', status: 'PENDING', entityId: 'user-1', createdAt: 200 },
    ];
    expect(await revokeRole('user-1', '_tide_kyc.selfdecrypt')).toEqual({ change_request_id: 'cr-new' });
  });

  it.each([
    [403, 'FORBIDDEN'],
    [409, 'CONFLICT'],
    [412, 'QUORUM_NOT_MET'],
    [404, 'ENTITY_VANISHED'],
    [500, 'UNEXPECTED'],
  ] as const)('%i → IgaError %s', async (status, code) => {
    deleteHandler = () => json(status, { error: 'x' });
    const err = await revokeRole('user-1', '_tide_kyc.selfdecrypt').catch((e) => e);
    expect(err).toBeInstanceOf(IgaError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });
});

describe('iga.getSaToken', () => {
  it('caches the token until expiry', async () => {
    const t1 = await getSaToken();
    const t2 = await getSaToken();
    expect(t2).toBe(t1);
    const tokenCalls = calls.filter((c) => c.url.endsWith('/openid-connect/token'));
    expect(tokenCalls).toHaveLength(1);
    const body = String(tokenCalls[0].init.body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=tidewatch-sa');
  });

  it('refetches after expiry', async () => {
    vi.useFakeTimers();
    try {
      await getSaToken();
      vi.advanceTimersByTime(61_000);
      await getSaToken();
      expect(calls.filter((c) => c.url.endsWith('/openid-connect/token'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('iga.listChangeRequests + route', () => {
  beforeEach(() => {
    listBody = [{ id: 'cr-1', status: 'PENDING', actionType: 'REVOKE', entityType: 'USER_ROLE', entityId: 'u', authorizationCount: 1, threshold: 2, createdAt: 1000 }];
  });

  it('maps IGA representation to ChangeRequest', async () => {
    const items = await listChangeRequests('PENDING');
    expect(items).toEqual([{ id: 'cr-1', status: 'PENDING', summary: expect.stringContaining('REVOKE'), approvals: 1, required: 2, updated_at: 1000 }]);
    expect(calls.at(-1)!.url).toBe(`${BASE}/admin/realms/tidewatch/iga/change-requests?status=PENDING`);
  });

  it('GET /api/change-requests returns ChangeRequestsRes; 403 when roles lack approver', async () => {
    const app = new Hono();
    registerIgaRoutes(app);
    const ok = await app.request('/api/change-requests?status=PENDING');
    expect(ok.status).toBe(200);
    expect((await ok.json()).items[0].id).toBe('cr-1');

    const guarded = new Hono<{ Variables: { roles: string[] } }>();
    guarded.use('*', async (c, next) => { c.set('roles', ['tw-monitor']); await next(); });
    registerIgaRoutes(guarded);
    expect((await guarded.request('/api/change-requests')).status).toBe(403);
  });
});
