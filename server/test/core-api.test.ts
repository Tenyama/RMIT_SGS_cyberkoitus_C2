import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/index.ts';
import { openDb, getDb } from '../src/db.ts';
import { actorHash } from '../src/hmac.ts';
import { openAlert, getAlert } from '../src/alerts.ts';
import { verify } from '../src/audit.ts';
import { ROLES } from '../../shared/types.ts';

const dev = (sub: string, roles: string[]) => ({ 'X-Dev-Sub': sub, 'X-Dev-Roles': roles.join(','), 'content-type': 'application/json' });

class FakeIgaError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
    this.name = 'IgaError';
  }
}

let prevMode: string | undefined;
beforeEach(() => {
  prevMode = process.env.AUTH_MODE;
});
afterEach(() => {
  process.env.AUTH_MODE = prevMode;
});

function mkApp(iga: any = {}) {
  process.env.AUTH_MODE = 'dev';
  return createApp({ db: openDb(':memory:'), clock: () => 5_000_000, iga });
}

describe('auth', () => {
  it('jwt mode: beacon without token → 401', async () => {
    process.env.AUTH_MODE = 'jwt';
    const app = createApp({ db: openDb(':memory:') });
    const r = await app.request('/api/telemetry/decrypt', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(401);
    const r2 = await app.request('/api/me', { headers: { authorization: 'Bearer not.a.jwt' } });
    expect(r2.status).toBe(401);
  });

  it('dev mode: /api/me and role enforcement', async () => {
    const app = mkApp();
    const me = await app.request('/api/me', { headers: dev('u1', [ROLES.STAFF, 'junk']) });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ actor_hash: actorHash('u1'), roles: [ROLES.STAFF] });
    expect((await app.request('/api/alerts', { headers: dev('u1', [ROLES.STAFF]) })).status).toBe(403);
    expect((await app.request('/api/kyc', { method: 'POST', headers: dev('u1', [ROLES.STAFF]), body: '{}' })).status).toBe(403);
    expect((await app.request('/api/alerts', { headers: dev('m', [ROLES.MONITOR]) })).status).toBe(200);
    expect((await app.request('/api/me')).status).toBe(401);
  });
});

describe('kyc', () => {
  it('create + paginated list', async () => {
    const app = mkApp();
    for (let i = 0; i < 3; i++) {
      const r = await app.request('/api/kyc', { method: 'POST', headers: dev('c', [ROLES.CUSTOMER]), body: JSON.stringify({ display_mask: `m${i}`, payload_ct: `ct${i}` }) });
      expect(r.status).toBe(201);
    }
    const p1 = await (await app.request('/api/kyc?limit=2', { headers: dev('s', [ROLES.STAFF]) })).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await (await app.request(`/api/kyc?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`, { headers: dev('s', [ROLES.STAFF]) })).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    expect(verify().ok).toBe(true);
  });
});

describe('beacon → alert → propose-revoke', () => {
  it('happy path', async () => {
    const calls: any[] = [];
    const app = mkApp({ revokeRole: async (sub: string, role: string) => (calls.push([sub, role]), { change_request_id: 'cr-9' }), listChangeRequests: async () => [] });
    const r = await app.request('/api/telemetry/decrypt', { method: 'POST', headers: dev('staff1', [ROLES.STAFF]), body: JSON.stringify({ tag: 'kyc', ok: true, latency_ms: 5, count: 50 }) });
    expect(r.status).toBe(202);
    const { items } = await (await app.request('/api/alerts?status=open', { headers: dev('m', [ROLES.MONITOR]) })).json();
    expect(items).toHaveLength(1);
    const pr = await app.request(`/api/alerts/${items[0].id}/propose-revoke`, { method: 'POST', headers: dev('m', [ROLES.MONITOR]) });
    expect(pr.status).toBe(202);
    expect(await pr.json()).toEqual({ change_request_id: 'cr-9' });
    expect(calls).toEqual([['staff1', ROLES.STAFF]]);
    expect(getAlert(items[0].id)).toMatchObject({ status: 'pending_quorum', change_request_id: 'cr-9' });
    // second propose → 409
    expect((await app.request(`/api/alerts/${items[0].id}/propose-revoke`, { method: 'POST', headers: dev('m', [ROLES.MONITOR]) })).status).toBe(409);
    const actions = getDb().prepare('SELECT action FROM audit_log ORDER BY seq').all().map((x: any) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['alert.propose_revoke']));
  });

  it('IgaError reverts to open and returns the code', async () => {
    const app = mkApp({
      revokeRole: async () => {
        throw new FakeIgaError('FORBIDDEN', 403);
      },
    });
    await app.request('/api/telemetry/decrypt', { method: 'POST', headers: dev('staff2', [ROLES.STAFF]), body: JSON.stringify({ tag: 'kyc', ok: true, latency_ms: 5, count: 60 }) });
    const id = (await (await app.request('/api/alerts', { headers: dev('m', [ROLES.MONITOR]) })).json()).items[0].id;
    const pr = await app.request(`/api/alerts/${id}/propose-revoke`, { method: 'POST', headers: dev('m', [ROLES.MONITOR]) });
    expect(pr.status).toBe(403);
    expect(await pr.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(getAlert(id)!.status).toBe('open');
  });

  it('unknown actor hash → 404; wrong kind → 409; dismiss → 200', async () => {
    const app = mkApp({ revokeRole: async () => ({ change_request_id: 'x' }) });
    const a = openAlert('decrypt_anomaly', 'crit', 'deadbeef', null);
    expect((await app.request(`/api/alerts/${a.id}/propose-revoke`, { method: 'POST', headers: dev('m', [ROLES.MONITOR]) })).status).toBe(404);
    expect(getAlert(a.id)!.status).toBe('open');
    const k = openAlert('key_margin', 'warn', 'kyc-key', null);
    expect((await app.request(`/api/alerts/${k.id}/propose-revoke`, { method: 'POST', headers: dev('m', [ROLES.MONITOR]) })).status).toBe(409);
    const d = await app.request(`/api/alerts/${k.id}/dismiss`, { method: 'POST', headers: dev('m', [ROLES.MONITOR]), body: JSON.stringify({ reason: 'test' }) });
    expect(d.status).toBe(200);
    expect(getAlert(k.id)!.status).toBe('dismissed');
  });
});
