// P2 seam (CONTRACTS): runCycle / retryApproved / attackDirect. Agents only talk HTTP with their own tokens.
import type { AgentName, InventoryRes, PurchaseOrder, SuppliersRes } from '../../../shared/types.ts';
import { call, setApiBase } from './api.ts';
import { markDevElevated } from './token.ts';
import { runAnalyst } from './analyst.ts';
import { runPlanner, draftAndSubmit, describeSubmit } from './planner.ts';
import { runException } from './exception.ts';

export type AgentLog = (agent: AgentName, step: string, message: string) => void;

const consoleLog: AgentLog = (a, s, m) => console.log(`[${a}] ${s}: ${m}`);
let lastLog: AgentLog = consoleLog;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const stepDelay = (o?: number) => o ?? Number(process.env.AGENT_STEP_DELAY_MS ?? 600);

export async function runCycle(opts: {
  apiBase: string;
  runId: string;
  log: AgentLog;
  delayMs?: number;
}): Promise<{ summary: string }> {
  setApiBase(opts.apiBase);
  lastLog = opts.log;
  const log = opts.log;
  const delay = stepDelay(opts.delayMs);

  log('analyst', 'start', `Chu kỳ ${opts.runId}: phân tích tồn kho`);
  await runAnalyst(log);
  await sleep(delay);

  log('planner', 'start', 'Lập đơn mua cho SKU có nguy cơ hết hàng');
  const pos = await runPlanner(log);
  await sleep(delay);

  const flagged = pos.filter((p) => p.status === 'blocked' || p.status === 'pending_approval');
  if (flagged.length) {
    log('exception', 'start', `Phân tích ${flagged.length} đơn ngoại lệ`);
    await runException(log, new Set(flagged.map((p) => p.id)));
  }

  const count = (s: PurchaseOrder['status']) => pos.filter((p) => p.status === s).length;
  const summary = `${count('executed')} tự động, ${count('blocked')} bị chặn, ${count('pending_approval')} chờ quorum`;
  log('planner', 'done', `Kết thúc ${opts.runId}: ${summary}`);
  return { summary };
}

/** After the IGA quorum approved: planner fetches a FRESH token (now carrying proc.exception-submit) and re-submits. */
export async function retryApproved(poId: string, log: AgentLog = lastLog): Promise<{ status: number; po: PurchaseOrder | null }> {
  if (process.env.AUTH_MODE === 'dev') markDevElevated(true); // emulates the IGA grant
  log('planner', 'retry', `Quorum đã duyệt ${poId}: lấy token mới và gửi lại`);
  const r = await call<PurchaseOrder>('planner', 'POST', `/api/po/${poId}/submit`, undefined, { force: true });
  const po = r.status === 200 ? r.json : null;
  log('planner', 'retry', describeSubmit(r.status, po, (r.json as any)?.error));
  return { status: r.status, po };
}

/** Demo attack: a hijacked planner skips its reasoning and pushes an ~80M VND cement order straight at the API. */
export async function attackDirect(log: AgentLog = lastLog): Promise<{ status: number; po: PurchaseOrder | null }> {
  const TARGET = 80_000_000;
  log('planner', 'attack', `⚠️ Mô phỏng agent bị chiếm quyền: gọi API trực tiếp, đơn ~${TARGET.toLocaleString('vi-VN')} VND`);
  const inv = await call<InventoryRes>('planner', 'GET', '/api/inventory');
  if (inv.status !== 200) return { status: inv.status, po: null };
  const products = inv.json.products;
  const cement = products.find((p) => /xi m[aă]ng|cement/i.test(p.name) || /^(CEM|XM)/i.test(p.sku)) ?? products[0];
  if (!cement) return { status: 404, po: null };
  const sup = await call<SuppliersRes>('planner', 'GET', `/api/suppliers?sku=${encodeURIComponent(cement.sku)}`);
  if (sup.status !== 200) return { status: sup.status, po: null };
  const approved = new Set(sup.json.suppliers.filter((s) => s.approved).map((s) => s.id));
  const offer = [...sup.json.offers].sort((a, b) => a.unit_price - b.unit_price).find((o) => approved.has(o.supplier_id))
    ?? sup.json.offers[0];
  if (!offer) return { status: 404, po: null };
  const qty = Math.ceil(TARGET / offer.unit_price);
  return draftAndSubmit({
    sku: cement.sku,
    supplier_id: offer.supplier_id,
    qty,
    justification: `Lệnh trực tiếp (bỏ qua bước lập kế hoạch): ${qty} ${cement.unit} ${cement.name}`,
  }, log);
}
