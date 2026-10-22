import { POLICY, type Product, type Recommendation, type Supplier, type SupplierOffer } from '../../shared/types.ts';

/** Deterministic reorder math. The LLM only explains this, never changes it. */
export function recommend(product: Product, bestLeadTimeDays: number): Recommendation {
  const d = product.avg_daily_demand;
  const reorder_point = Math.ceil(d * bestLeadTimeDays + product.safety_stock);
  const projected = product.on_hand + product.on_order;
  if (projected <= reorder_point) {
    const recommended_qty = Math.max(0, Math.ceil(d * (bestLeadTimeDays + POLICY.REVIEW_DAYS) + product.safety_stock - projected));
    return { sku: product.sku, reorder_point, projected, recommended_qty, status: 'stockout_risk' };
  }
  return { sku: product.sku, reorder_point, projected, recommended_qty: 0, status: projected > 3 * reorder_point ? 'overstock' : 'ok' };
}

/** Shortest lead time among APPROVED suppliers' offers for the SKU (fallback: any offer, then REVIEW_DAYS). */
export function bestLeadTime(sku: string, offers: SupplierOffer[], suppliers: Supplier[]): number {
  const approved = new Set(suppliers.filter((s) => s.approved).map((s) => s.id));
  const forSku = offers.filter((o) => o.sku === sku);
  const pool = forSku.filter((o) => approved.has(o.supplier_id));
  const use = pool.length ? pool : forSku;
  return use.length ? Math.min(...use.map((o) => o.lead_time_days)) : POLICY.REVIEW_DAYS;
}
