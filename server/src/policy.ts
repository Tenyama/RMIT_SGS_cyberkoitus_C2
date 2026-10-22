import {
  PERMISSIONS, POLICY,
  type PoStatus, type PolicyCheck, type Product, type PurchaseOrder, type Recommendation, type Supplier,
} from '../../shared/types.ts';

export interface SubmitCtx {
  now: number;
  dailySpent: number; // sum of totals of POs executed today by agents
  supplier: Supplier | null;
  product: Product;
  recommendation: Recommendation;
  quorumApproved: boolean; // actor has EXCEPTION_SUBMIT AND this PO's CR approved AND exception_used=0
}

export type PoForPolicy = Pick<PurchaseOrder, 'qty' | 'unit_price' | 'total'>;

const vnd = (n: number) => `${n.toLocaleString('en-US')} VND`;

export function permissionsOf(roles: string[]): string[] {
  return [...new Set(roles.flatMap((r) => PERMISSIONS[r] ?? []))];
}

/**
 * Pure policy decision for POST /po/:id/submit.
 * Hard (blocked, quorum cannot override): role, supplier_approved, price_sanity.
 * Soft (pending_approval, quorum can override once): qty_sanity, po_limit, daily_limit.
 */
export function evaluateSubmit(
  po: PoForPolicy,
  actor: { label: string; roles: string[] },
  ctx: SubmitCtx,
): { status: PoStatus; checks: PolicyCheck[] } {
  const checks: PolicyCheck[] = [];
  const hard: boolean[] = [];
  const soft: boolean[] = [];

  const roleOk = permissionsOf(actor.roles).includes('po:submit');
  checks.push({ rule: 'role', ok: roleOk, detail: roleOk ? `${actor.label} has po:submit` : `${actor.label} lacks po:submit` });
  hard.push(roleOk);

  const supOk = !!ctx.supplier?.approved;
  checks.push({
    rule: 'supplier_approved', ok: supOk,
    detail: supOk ? `Supplier ${ctx.supplier!.name} approved` : `Supplier ${ctx.supplier?.name ?? '?'} not approved`,
  });
  hard.push(supOk);

  const ref = ctx.product.reference_price;
  const dev = ref > 0 ? Math.abs(po.unit_price - ref) / ref : Infinity;
  const priceOk = dev <= POLICY.PRICE_TOLERANCE + 1e-9;
  checks.push({
    rule: 'price_sanity', ok: priceOk,
    detail: `Unit price ${vnd(po.unit_price)} is ${(dev * 100).toFixed(0)}% off reference ${vnd(ref)} (max ±${POLICY.PRICE_TOLERANCE * 100}%)`,
  });
  hard.push(priceOk);

  const rec = ctx.recommendation.recommended_qty;
  const maxQty = POLICY.MAX_QTY_FACTOR * rec;
  const qtyOk = rec > 0 && po.qty <= maxQty;
  checks.push({
    rule: 'qty_sanity', ok: qtyOk,
    detail: rec === 0
      ? `No reorder recommended (rec 0), requested ${po.qty}`
      : `Qty ${po.qty} ${qtyOk ? '≤' : '>'} ${POLICY.MAX_QTY_FACTOR}× recommended ${rec} (${maxQty})`,
  });
  soft.push(qtyOk);

  const poOk = po.total <= POLICY.AGENT_PO_LIMIT;
  checks.push({ rule: 'po_limit', ok: poOk, detail: `Total ${vnd(po.total)} ${poOk ? '≤' : '>'} per-order limit ${vnd(POLICY.AGENT_PO_LIMIT)}` });
  soft.push(poOk);

  const dayTotal = ctx.dailySpent + po.total;
  const dayOk = dayTotal <= POLICY.AGENT_DAILY_LIMIT;
  checks.push({ rule: 'daily_limit', ok: dayOk, detail: `Spent today ${vnd(ctx.dailySpent)} + ${vnd(po.total)} ${dayOk ? '≤' : '>'} daily limit ${vnd(POLICY.AGENT_DAILY_LIMIT)}` });
  soft.push(dayOk);

  if (hard.includes(false)) return { status: 'blocked', checks };
  if (soft.includes(false)) {
    if (ctx.quorumApproved) {
      checks.push({ rule: 'quorum', ok: true, detail: 'TideCloak quorum approved an exception for this PO (single use)' });
      return { status: 'executed', checks };
    }
    checks.push({ rule: 'quorum', ok: false, detail: 'Exceeds agent authority: needs IGA quorum approval' });
    return { status: 'pending_approval', checks };
  }
  return { status: 'executed', checks };
}
