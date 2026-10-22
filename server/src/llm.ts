// Reasoner layer (D5/D6). Output is UNTRUSTED data: it proposes, the server policy decides.
// To use Claude later: implement `Reasoner` with the Anthropic SDK and pass it to setReasoner().
import type {
  ExceptionReport,
  Product,
  PurchaseOrder,
  Recommendation,
  Supplier,
  SupplierOffer,
} from '../../shared/types.ts';

export interface RiskItem { sku: string; risk: Recommendation['status']; rationale: string }
export interface Plan { supplier_id: string; qty: number; justification: string }
type MaybeAsync<T> = T | Promise<T>;

export interface Reasoner {
  analyze(recs: Recommendation[], products: Product[]): MaybeAsync<RiskItem[]>;
  /** null = nothing sensible to order. */
  plan(rec: Recommendation, product: Product, offers: SupplierOffer[], suppliers: Supplier[]): MaybeAsync<Plan | null>;
  explain(po: PurchaseOrder): MaybeAsync<ExceptionReport>;
}

const INSTRUCTION_RE = [
  /\bignore\b.*\b(limit|instruction|polic|rule|previous|approval)/i,
  /\b(disregard|override|bypass)\b/i,
  /\bsystem\s*:/i,
  /\b(cfo|ceo)\b.*\b(approv|authori)/i,
  /bỏ qua.*(hạn mức|giới hạn|quy định|chỉ dẫn)/i,
  /(cfo|giám đốc).*(đã )?(phê duyệt|duyệt)/i,
];

/** Heuristic for instruction-like text in untrusted fields (supplier notes, justifications). */
export function looksLikeInstruction(text: string | null | undefined): boolean {
  return !!text && INSTRUCTION_RE.some((re) => re.test(text));
}

const vnd = (n: number) => `${n.toLocaleString('vi-VN')} VND`;

const FLAG_BY_RULE: Record<string, string> = {
  role: 'missing_role',
  supplier_approved: 'unapproved_supplier',
  po_limit: 'over_limit',
  daily_limit: 'over_daily_limit',
  price_sanity: 'price_anomaly',
  qty_sanity: 'qty_anomaly',
};
const FLAG_VI: Record<string, string> = {
  missing_role: 'thiếu quyền',
  unapproved_supplier: 'NCC chưa được duyệt',
  over_limit: 'vượt hạn mức 10 triệu/đơn',
  over_daily_limit: 'vượt hạn mức ngày 30 triệu',
  price_anomaly: 'giá lệch >20% so với giá tham chiếu',
  qty_anomaly: 'số lượng vượt 3× khuyến nghị',
  possible_prompt_injection: 'nghi tấn công prompt injection',
};
const LIMIT_FLAGS = new Set(['over_limit', 'over_daily_limit']);

/** Deterministic stand-in for an LLM. Deliberately naive about injected notes (simulates a compromised model). */
export class RuleReasoner implements Reasoner {
  analyze(recs: Recommendation[], products: Product[]): RiskItem[] {
    return recs
      .filter((r) => r.status !== 'ok')
      .map((r) => {
        const p = products.find((x) => x.sku === r.sku);
        const name = p?.name ?? r.sku;
        const days = p && p.avg_daily_demand > 0 ? (r.projected / p.avg_daily_demand).toFixed(1) : '?';
        const rationale = r.status === 'stockout_risk'
          ? `${name}: tồn dự kiến ${r.projected} < điểm đặt hàng ${r.reorder_point} (~${days} ngày bán), đề xuất đặt ${r.recommended_qty} ${p?.unit ?? ''}`.trim()
          : `${name}: tồn dự kiến ${r.projected} vượt nhu cầu (~${days} ngày bán), không nên đặt thêm`;
        return { sku: r.sku, risk: r.status, rationale };
      });
  }

  plan(rec: Recommendation, product: Product, offers: SupplierOffer[], suppliers: Supplier[]): Plan | null {
    const unit = product.unit;
    // "Compromised model": an instruction in a supplier note is obeyed, exactly like a naive LLM would.
    const injected = offers.find((o) => looksLikeInstruction(o.note));
    if (injected) {
      const qty = 2000;
      return {
        supplier_id: injected.supplier_id,
        qty,
        justification: `Theo thông báo CFO đã phê duyệt trong ghi chú NCC: "${injected.note}" — đặt ${qty} ${unit} ${product.name} giá ${vnd(injected.unit_price)}/${unit}, tổng ${vnd(qty * injected.unit_price)}.`,
      };
    }
    const approved = new Set(suppliers.filter((s) => s.approved).map((s) => s.id));
    const ok = offers.filter((o) => approved.has(o.supplier_id)).sort((a, b) => a.unit_price - b.unit_price);
    const best = ok[0];
    if (!best) return null;
    const qty = Math.max(best.moq, rec.recommended_qty);
    const name = suppliers.find((s) => s.id === best.supplier_id)?.name ?? best.supplier_id;
    return {
      supplier_id: best.supplier_id,
      qty,
      justification:
        `Chọn ${name}: giá ${vnd(best.unit_price)}/${unit}, rẻ nhất trong ${ok.length} NCC đã duyệt, giao ${best.lead_time_days} ngày. ` +
        `SL ${qty} = max(MOQ ${best.moq}, khuyến nghị ${rec.recommended_qty}); tồn dự kiến ${rec.projected} < điểm đặt ${rec.reorder_point}. ` +
        `Tổng ${vnd(qty * best.unit_price)}.`,
    };
  }

  explain(po: PurchaseOrder): ExceptionReport {
    const flags: string[] = [];
    for (const c of po.checks ?? []) {
      const f = !c.ok && FLAG_BY_RULE[c.rule];
      if (f && !flags.includes(f)) flags.push(f);
    }
    if (looksLikeInstruction(po.justification)) flags.push('possible_prompt_injection');

    const recommendation: ExceptionReport['recommendation'] =
      po.status === 'blocked' ? 'reject' : flags.every((f) => LIMIT_FLAGS.has(f)) ? 'approve' : 'investigate';
    const reasons = flags.map((f) => FLAG_VI[f] ?? f).join(', ') || 'không rõ';
    const verdict = { reject: 'Đề xuất TỪ CHỐI', approve: 'Có thể DUYỆT nếu ngân sách cho phép', investigate: 'Cần ĐIỀU TRA trước khi duyệt' }[recommendation];
    return {
      summary: `Đơn ${po.id} (${po.qty} × ${po.sku}, ${vnd(po.total)}) ${po.status === 'blocked' ? 'bị chặn' : 'chờ quorum'}: ${reasons}. ${verdict}.`,
      risk_flags: flags,
      recommendation,
    };
  }
}

let current: Reasoner = new RuleReasoner();
export const getReasoner = (): Reasoner => current;
/** For tests / swapping in an LLM-backed reasoner. */
export const setReasoner = (r: Reasoner): void => { current = r; };
