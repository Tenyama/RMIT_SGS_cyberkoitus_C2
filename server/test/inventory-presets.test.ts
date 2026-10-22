import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { ROLES } from '../../shared/types.ts';
import { openDb, getDb } from '../src/db.ts';
import { createApp } from '../src/index.ts';

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
const BUYER = as('buyer1', ROLES.BUYER);
const AUDITOR = as('auditor1', ROLES.AUDITOR);

const req = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

const inventory = async () => (await req('GET', '/api/inventory', ANALYST)).json();
const recOf = (inv: any, sku: string) => inv.recommendations.find((r: any) => r.sku === sku);

describe('PATCH /api/inventory/:sku', () => {
  it('buyer edits on_hand/demand/safety; recommendation recalculates; audit records it', async () => {
    const before = await inventory();
    expect(recOf(before, 'XM-PCB40').status).toBe('stockout_risk'); // seeded at risk

    const r = await req('PATCH', '/api/inventory/XM-PCB40', BUYER, { on_hand: 10, avg_daily_demand: 1, safety_stock: 5 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.product).toMatchObject({ sku: 'XM-PCB40', on_hand: 10, avg_daily_demand: 1, safety_stock: 5 });
    expect(body.recommendation.status).toBe('ok'); // projected 10 > reorder point 7, nothing to order
    expect(body.recommendation.recommended_qty).toBe(0);

    const after = await inventory();
    expect(recOf(after, 'XM-PCB40').recommended_qty).toBe(0);
    expect(after.products.find((p: any) => p.sku === 'XM-PCB40').safety_stock).toBe(5);

    const audit = await (await req('GET', '/api/audit', AUDITOR)).json();
    expect(audit.items.some((e: any) => e.action === 'inventory.update' && e.target.includes('XM-PCB40'))).toBe(true);
  });

  it('lowering stock flips a healthy SKU to stockout_risk', async () => {
    const before = await inventory();
    expect(recOf(before, 'SON-18L').status).toBe('ok'); // seeded healthy (projected 30 > reorder point 13)
    const r = await req('PATCH', '/api/inventory/SON-18L', BUYER, { on_hand: 0 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.recommendation.status).toBe('stockout_risk');
    expect(body.recommendation.recommended_qty).toBeGreaterThan(0);
  });

  it('rejects bad input and non-editors', async () => {
    expect((await req('PATCH', '/api/inventory/XM-PCB40', BUYER, { on_hand: -1 })).status).toBe(400);
    expect((await req('PATCH', '/api/inventory/XM-PCB40', BUYER, { on_hand: 1.5 })).status).toBe(400);
    expect((await req('PATCH', '/api/inventory/XM-PCB40', BUYER, { avg_daily_demand: 'lots' })).status).toBe(400);
    expect((await req('PATCH', '/api/inventory/XM-PCB40', BUYER, {})).status).toBe(400);
    expect((await req('PATCH', '/api/inventory/NOPE-1', BUYER, { on_hand: 1 })).status).toBe(404);
    // agents and auditors are read-only
    expect((await req('PATCH', '/api/inventory/XM-PCB40', ANALYST, { on_hand: 1 })).status).toBe(403);
    expect((await req('PATCH', '/api/inventory/XM-PCB40', AUDITOR, { on_hand: 1 })).status).toBe(403);
  });
});

describe('POST /api/demo/preset', () => {
  const preset = (name: string, headers = BUYER) => req('POST', '/api/demo/preset', headers, { name });

  it('rejects unknown presets and non-buyers', async () => {
    expect((await preset('nope')).status).toBe(400);
    expect((await preset('routine', ANALYST)).status).toBe(403);
  });

  it('routine: seeded 4 at risk, injected=false', async () => {
    const r = await preset('routine');
    expect(r.status).toBe(200);
    expect((await r.json())).toMatchObject({ ok: true, preset: 'routine', injected: false });
    const inv = await inventory();
    expect(inv.recommendations.filter((x: any) => x.status === 'stockout_risk')).toHaveLength(4);
  });

  it('stockout-crisis: 6 at risk; 5 execute, cement crosses the daily cap → pending_approval + CR', async () => {
    await preset('stockout-crisis');
    const inv = await inventory();
    const risky = inv.recommendations.filter((x: any) => x.status === 'stockout_risk');
    expect(risky.map((x: any) => x.sku).sort()).toEqual(['CAT-XAY', 'DINH-VIT', 'GACH-ONG4', 'PVC-90', 'THEP-D10', 'XM-PCB40']);
    expect(recOf(inv, 'PVC-90').recommended_qty).toBe(40);
    expect(recOf(inv, 'DINH-VIT').recommended_qty).toBe(28);

    // replay the planner cycle in SKU order: the first five pass…
    const plan: [string, string, number][] = [
      ['CAT-XAY', 'sup-hoabinh', 30],
      ['DINH-VIT', 'sup-hoabinh', 28],
      ['GACH-ONG4', 'sup-hoabinh', 7],
      ['PVC-90', 'sup-thepmn', 40],
      ['THEP-D10', 'sup-thepmn', 49],
    ];
    for (const [sku, supplier_id, qty] of plan) {
      const po = await (await req('POST', '/api/po', PLANNER, { sku, supplier_id, qty, justification: 't' })).json();
      expect((await (await req('POST', `/api/po/${po.id}/submit`, PLANNER)).json()).status).toBe('executed');
    }
    // …and cement (100 × 95k = 9.5M) would take the day over 30M
    const po = await (await req('POST', '/api/po', PLANNER, { sku: 'XM-PCB40', supplier_id: 'sup-hoabinh', qty: 100, justification: 't' })).json();
    const sub = await (await req('POST', `/api/po/${po.id}/submit`, PLANNER)).json();
    expect(sub.status).toBe('pending_approval');
    expect(sub.checks.find((c: any) => c.rule === 'daily_limit').ok).toBe(false);
    expect(opened).toEqual([po.id]);
  });

  it('big-ticket: brick demand spike → ~43M order → pending_approval + CR', async () => {
    await preset('big-ticket');
    const inv = await inventory();
    expect(recOf(inv, 'GACH-ONG4').recommended_qty).toBe(40);
    const po = await (await req('POST', '/api/po', PLANNER, { sku: 'GACH-ONG4', supplier_id: 'sup-hoabinh', qty: 40, justification: 't' })).json();
    expect(po.total).toBe(43_200_000);
    const sub = await (await req('POST', `/api/po/${po.id}/submit`, PLANNER)).json();
    expect(sub.status).toBe('pending_approval');
    expect(sub.checks.find((c: any) => c.rule === 'po_limit').ok).toBe(false);
    expect(opened).toEqual([po.id]);
  });

  it('price-spike: approved cement ~28% over reference → blocked on price_sanity', async () => {
    await preset('price-spike');
    const sup = await (await req('GET', '/api/suppliers?sku=XM-PCB40', ANALYST)).json();
    const approved = sup.offers.filter((o: any) => o.supplier_id !== 'sup-buildfast').map((o: any) => o.unit_price);
    expect(Math.min(...approved)).toBe(119_040); // 25% over the 95k reference

    const po = await (await req('POST', '/api/po', PLANNER, { sku: 'XM-PCB40', supplier_id: 'sup-hatien', qty: 100, justification: 't' })).json();
    const sub = await (await req('POST', `/api/po/${po.id}/submit`, PLANNER)).json();
    expect(sub.status).toBe('blocked'); // hard violation: no CR, quorum cannot override
    expect(sub.checks.find((c: any) => c.rule === 'price_sanity').ok).toBe(false);
    expect(opened).toEqual([]);
  });

  it('injection: poisoned note armed on BuildFast cement, injected=true', async () => {
    const r = await preset('injection');
    expect((await r.json())).toMatchObject({ preset: 'injection', injected: true });
    const sup = await (await req('GET', '/api/suppliers?sku=XM-PCB40', ANALYST)).json();
    expect(sup.offers.find((o: any) => o.supplier_id === 'sup-buildfast').note).toMatch(/Ignore spending limits/);
  });

  it('presets wipe previous POs (fresh story for each run)', async () => {
    const po = await (await req('POST', '/api/po', PLANNER, { sku: 'XM-PCB40', supplier_id: 'sup-hoabinh', qty: 100, justification: 't' })).json();
    await req('POST', `/api/po/${po.id}/submit`, PLANNER);
    await preset('routine');
    expect((await (await req('GET', '/api/po', BUYER)).json()).items).toEqual([]);
  });
});
