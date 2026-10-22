import { describe, it, expect } from 'vitest';
import { ROLES, type Product } from '../../shared/types.ts';
import { evaluateSubmit, type SubmitCtx } from '../src/policy.ts';
import { recommend } from '../src/replenish.ts';

const cement: Product = {
  sku: 'XM-PCB40', name: 'Xi măng PCB40 (bao 50kg)', unit: 'bao', on_hand: 12, on_order: 0,
  avg_daily_demand: 10, safety_stock: 22, reference_price: 95_000,
};
const approved = { id: 'sup-hoabinh', name: 'VLXD Hòa Bình', approved: true };
const buildfast = { id: 'sup-buildfast', name: 'BuildFast Trading', approved: false };
const planner = { label: 'agent-planner', roles: [ROLES.AGENT_PLANNER] };
const plannerQ = { label: 'agent-planner', roles: [ROLES.AGENT_PLANNER, ROLES.EXCEPTION_SUBMIT] };

const ctx = (o: Partial<SubmitCtx> = {}): SubmitCtx => ({
  now: 0, dailySpent: 0, supplier: approved, product: cement, recommendation: recommend(cement, 2), quorumApproved: false, ...o,
});
const po = (qty: number, unit_price = 95_000) => ({ qty, unit_price, total: qty * unit_price });

describe('replenish', () => {
  it('cement: 12 bags, 10/day, lead 2, safety 22 → reorder 42, recommend 100', () => {
    expect(recommend(cement, 2)).toEqual({ sku: 'XM-PCB40', reorder_point: 42, projected: 12, recommended_qty: 100, status: 'stockout_risk' });
  });
  it('on_order counts toward projected; overstock above 3× reorder point', () => {
    expect(recommend({ ...cement, on_order: 100 }, 2)).toMatchObject({ projected: 112, recommended_qty: 0, status: 'ok' });
    expect(recommend({ ...cement, on_hand: 200 }, 2)).toMatchObject({ recommended_qty: 0, status: 'overstock' });
  });
});

describe('evaluateSubmit', () => {
  const rules = (r: ReturnType<typeof evaluateSubmit>) => Object.fromEntries(r.checks.map((c) => [c.rule, c.ok]));

  it.each([
    ['within limit → executed', po(100), planner, ctx(), 'executed'],
    ['unapproved supplier → blocked', po(2000, 76_000), planner, ctx({ supplier: buildfast }), 'blocked'],
    ['80M → pending_approval', po(842), planner, ctx(), 'pending_approval'],
    ['price +50% → blocked', po(100, 142_500), planner, ctx(), 'blocked'],
    ['daily limit exceeded → pending_approval', po(100), planner, ctx({ dailySpent: 25_000_000 }), 'pending_approval'],
    ['no po:submit role → blocked', po(100), { label: 'buyer1', roles: [ROLES.BUYER] }, ctx(), 'blocked'],
  ] as const)('%s', (_n, p, a, c, want) => {
    const r = evaluateSubmit(p, { label: a.label, roles: [...a.roles] }, c);
    expect(r.status).toBe(want);
    expect(r.checks.map((x) => x.rule)).toEqual(expect.arrayContaining(['role', 'supplier_approved', 'price_sanity', 'qty_sanity', 'po_limit', 'daily_limit']));
    for (const x of r.checks) expect(x.detail.length).toBeGreaterThan(0);
  });

  it('quorum approved once → executed; second time (exception_used) → pending_approval again', () => {
    const first = evaluateSubmit(po(842), plannerQ, ctx({ quorumApproved: true }));
    expect(first.status).toBe('executed');
    expect(rules(first).quorum).toBe(true);
    const second = evaluateSubmit(po(842), plannerQ, ctx({ quorumApproved: false }));
    expect(second.status).toBe('pending_approval');
    expect(rules(second).quorum).toBe(false);
  });

  it('quorum never overrides a hard violation', () => {
    expect(evaluateSubmit(po(2000, 76_000), plannerQ, ctx({ supplier: buildfast, quorumApproved: true })).status).toBe('blocked');
  });
});
