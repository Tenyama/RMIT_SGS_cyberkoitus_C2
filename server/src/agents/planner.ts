import type { InventoryRes, PoDraftReq, PolicyCheck, PurchaseOrder, SuppliersRes } from '../../../shared/types.ts';
import { getReasoner } from '../llm.ts';
import { call } from './api.ts';
import type { AgentLog } from './index.ts';

const RULE_VI: Record<PolicyCheck['rule'], string> = {
  role: 'thiếu quyền',
  supplier_approved: 'NCC chưa được duyệt',
  po_limit: 'vượt hạn mức 10 triệu/đơn',
  daily_limit: 'vượt hạn mức ngày 30 triệu',
  price_sanity: 'giá lệch >20% so với tham chiếu',
  qty_sanity: 'số lượng vượt 3× khuyến nghị',
  quorum: 'chưa có quorum phê duyệt',
};

export function describeSubmit(status: number, po: PurchaseOrder | null, err?: string): string {
  if (!po || status >= 400 || status === 0) return `❌ Gửi thất bại (HTTP ${status}): ${err ?? ''}`.trim();
  const failed = (po.checks ?? []).filter((c) => !c.ok).map((c) => RULE_VI[c.rule] ?? c.rule).join(', ');
  const head = `${po.id} ${po.qty} × ${po.sku} = ${po.total.toLocaleString('vi-VN')} VND`;
  switch (po.status) {
    case 'executed': return `✅ Đã thực thi: ${head}`;
    case 'blocked': return `⛔ Bị chặn: ${failed || 'vi phạm chính sách'} (${head})`;
    case 'pending_approval': return `⏳ Chờ quorum: ${failed || 'vượt thẩm quyền agent'} (${head})`;
    default: return `ℹ️ ${po.status}: ${head}${failed ? ` — ${failed}` : ''}`;
  }
}

/** Draft + submit one PO as agent-planner; logs the server's verdict. */
export async function draftAndSubmit(req: PoDraftReq, log: AgentLog): Promise<{ status: number; po: PurchaseOrder | null }> {
  const d = await call<PurchaseOrder>('planner', 'POST', '/api/po', req);
  if (d.status !== 201 && d.status !== 200) {
    log('planner', 'draft', `❌ Không tạo được đơn (HTTP ${d.status}): ${(d.json as any)?.error ?? ''}`.trim());
    return { status: d.status, po: null };
  }
  log('planner', 'draft', `📝 Nháp ${d.json.id}: ${req.qty} × ${req.sku} từ ${req.supplier_id}`);
  const s = await call<PurchaseOrder>('planner', 'POST', `/api/po/${d.json.id}/submit`);
  const ok = s.status === 200;
  log('planner', 'submit', describeSubmit(s.status, ok ? s.json : null, (s.json as any)?.error));
  return { status: s.status, po: ok ? s.json : d.json };
}

/** For each stockout_risk SKU: suppliers → reasoner.plan → draft → submit. */
export async function runPlanner(log: AgentLog): Promise<PurchaseOrder[]> {
  const inv = await call<InventoryRes>('planner', 'GET', '/api/inventory');
  if (inv.status !== 200) {
    log('planner', 'error', `Không đọc được tồn kho (HTTP ${inv.status})`);
    return [];
  }
  const out: PurchaseOrder[] = [];
  for (const rec of inv.json.recommendations.filter((r) => r.status === 'stockout_risk')) {
    const product = inv.json.products.find((p) => p.sku === rec.sku);
    if (!product) continue;
    const sup = await call<SuppliersRes>('planner', 'GET', `/api/suppliers?sku=${encodeURIComponent(rec.sku)}`);
    if (sup.status !== 200) {
      log('planner', 'error', `Không đọc được NCC cho ${rec.sku} (HTTP ${sup.status})`);
      continue;
    }
    // Offers (incl. untrusted supplier notes) go to the reasoner verbatim — that is the attack surface;
    // the server policy, not this code, must stop a bad plan.
    const plan = await getReasoner().plan(rec, product, sup.json.offers, sup.json.suppliers);
    if (!plan) {
      log('planner', 'plan', `Bỏ qua ${rec.sku}: không có NCC phù hợp`);
      continue;
    }
    log('planner', 'plan', `🤖 ${product.name}: ${plan.justification}`);
    const r = await draftAndSubmit({ sku: rec.sku, supplier_id: plan.supplier_id, qty: plan.qty, justification: plan.justification }, log);
    if (r.po) out.push(r.po);
  }
  return out;
}
