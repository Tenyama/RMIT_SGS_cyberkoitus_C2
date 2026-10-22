import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { ROLES } from '../../shared/types.ts';
import { openDb, getDb } from '../src/db.ts';
import { createApp, markApproved } from '../src/index.ts';

beforeAll(() => {
  process.env.AUTH_MODE = 'dev';
});

let app: ReturnType<typeof createApp>;
let opened: string[];
beforeEach(() => {
  opened = [];
  app = createApp({
    db: openDb(':memory:'),
    loadIga: async () => ({ openExceptionRequest: async (poId: string) => (opened.push(poId), { change_request_id: `cr-${poId}` }) }),
    loadAgents: async () => null,
  });
});

const as = (sub: string, ...roles: string[]) => ({ 'x-dev-sub': sub, 'x-dev-roles': roles.join(','), 'content-type': 'application/json' });
const ANALYST = as('agent-analyst', ROLES.AGENT_ANALYST);
const PLANNER = as('agent-planner', ROLES.AGENT_PLANNER);
const PLANNER_Q = as('agent-planner', ROLES.AGENT_PLANNER, ROLES.EXCEPTION_SUBMIT);
const BUYER = as('buyer1', ROLES.BUYER);
const AUDITOR = as('auditor1', ROLES.AUDITOR);

const req = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const draft = async (headers: Record<string, string>, supplier_id: string, qty: number) =>
  req('POST', '/api/po', headers, { sku: 'XM-PCB40', supplier_id, qty, justification: 't' });

describe('core routes', () => {
  it('health needs no auth; others 401 without identity', async () => {
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/inventory')).status).toBe(401);
  });

  it('agent-analyst reads inventory (4 at risk, cement wants 100) but cannot POST /po', async () => {
    const inv = await (await req('GET', '/api/inventory', ANALYST)).json();
    const risky = inv.recommendations.filter((r: any) => r.status === 'stockout_risk');
    expect(risky).toHaveLength(4);
    expect(inv.recommendations.find((r: any) => r.sku === 'XM-PCB40').recommended_qty).toBe(100);
    const r = await draft(ANALYST, 'sup-hoabinh', 100);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('FORBIDDEN');
  });

  it('agent-planner drafts + submits 100 bags → executed, on_order updated', async () => {
    const po = await (await draft(PLANNER, 'sup-hoabinh', 100)).json();
    expect(po).toMatchObject({ status: 'draft', unit_price: 95_000, total: 9_500_000, created_by: 'agent-planner' });
    const sub = await (await req('POST', `/api/po/${po.id}/submit`, PLANNER)).json();
    expect(sub.status).toBe('executed');
    const inv = await (await req('GET', '/api/inventory', ANALYST)).json();
    expect(inv.products.find((p: any) => p.sku === 'XM-PCB40').on_order).toBe(100);
  });

  it('BuildFast 2000 bags → blocked, no CR opened', async () => {
    const po = await (await draft(PLANNER, 'sup-buildfast', 2000)).json();
    const sub = await (await req('POST', `/api/po/${po.id}/submit`, PLANNER)).json();
    expect(sub.status).toBe('blocked');
    expect(opened).toEqual([]);
  });

  it('900 bags → pending_approval with CR; approved + exception role → executed once', async () => {
    const po = await (await draft(PLANNER, 'sup-hoabinh', 900)).json();
    const sub = await (await req('POST', `/api/po/${po.id}/submit`, PLANNER)).json();
    expect(sub).toMatchObject({ status: 'pending_approval', change_request_id: `cr-${po.id}` });
    // without approval the exception role does nothing
    expect((await (await req('POST', `/api/po/${po.id}/submit`, PLANNER_Q)).json()).status).toBe('pending_approval');
    markApproved(po.id);
    const ex = await (await req('POST', `/api/po/${po.id}/submit`, PLANNER_Q)).json();
    expect(ex.status).toBe('executed');
    expect(ex.checks.find((c: any) => c.rule === 'quorum').ok).toBe(true);
    expect((await req('POST', `/api/po/${po.id}/submit`, PLANNER_Q)).status).toBe(409);
    // a second over-limit PO does not inherit the approval
    const po2 = await (await draft(PLANNER, 'sup-hoabinh', 900)).json();
    expect((await (await req('POST', `/api/po/${po2.id}/submit`, PLANNER_Q)).json()).status).not.toBe('executed');
  });

  it('pending stays pending (CR null) when iga module is missing', async () => {
    app = createApp({ db: openDb(':memory:'), loadIga: async () => null, loadAgents: async () => null });
    const po = await (await draft(PLANNER, 'sup-hoabinh', 900)).json();
    const sub = await (await req('POST', `/api/po/${po.id}/submit`, PLANNER)).json();
    expect(sub).toMatchObject({ status: 'pending_approval', change_request_id: null });
    expect(sub.checks.find((c: any) => c.rule === 'quorum').detail).toMatch(/iga module not installed/);
  });

  it('buyer cannot submit (403)', async () => {
    const po = await (await draft(PLANNER, 'sup-hoabinh', 100)).json();
    expect((await req('POST', `/api/po/${po.id}/submit`, BUYER)).status).toBe(403);
  });

  it('agents/run without agents module → 202', async () => {
    const r = await req('POST', '/api/agents/run', BUYER);
    expect(r.status).toBe(202);
    expect((await r.json()).run_id).toMatch(/^run-/);
  });

  it('auditor reads /audit valid=true; tampering one row → valid=false', async () => {
    const po = await (await draft(PLANNER, 'sup-hoabinh', 100)).json();
    await req('POST', `/api/po/${po.id}/submit`, PLANNER);
    const a = await (await req('GET', '/api/audit', AUDITOR)).json();
    expect(a.valid).toBe(true);
    expect(a.items.length).toBeGreaterThanOrEqual(2);
    expect((await req('GET', '/api/audit', PLANNER)).status).toBe(403);
    getDb().prepare("UPDATE audit_log SET actor = 'someone-else' WHERE seq = 1").run();
    expect((await (await req('GET', '/api/audit', AUDITOR)).json()).valid).toBe(false);
  });

  it('demo inject puts the note on BuildFast cement; reset clears POs', async () => {
    await req('POST', '/api/demo/inject', BUYER, { enabled: true });
    const s = await (await req('GET', '/api/suppliers?sku=XM-PCB40', ANALYST)).json();
    expect(s.offers.find((o: any) => o.supplier_id === 'sup-buildfast').note).toMatch(/Ignore spending limits/);
    await draft(PLANNER, 'sup-hoabinh', 100);
    await req('POST', '/api/demo/reset', BUYER);
    expect((await (await req('GET', '/api/po', BUYER)).json()).items).toEqual([]);
  });
});
