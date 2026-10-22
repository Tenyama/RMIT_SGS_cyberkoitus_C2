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

  log('analyst', 'start', `Run ${opts.runId}: analyzing inventory`);
  await runAnalyst(log);
  await sleep(delay);

  log('planner', 'start', 'Drafting POs for at-risk SKUs');
  const pos = await runPlanner(log);
  await sleep(delay);

  const flagged = pos.filter((p) => p.status === 'blocked' || p.status === 'pending_approval');
  if (flagged.length) {
    log('exception', 'start', `Explaining ${flagged.length} exception POs`);
    await runException(log, new Set(flagged.map((p) => p.id)));
  }

  const count = (s: PurchaseOrder['status']) => pos.filter((p) => p.status === s).length;
  const summary = `${count('executed')} auto-executed, ${count('blocked')} blocked, ${count('pending_approval')} awaiting quorum`;
  log('planner', 'done', `Run ${opts.runId} done: ${summary}`);
  return { summary };
}

/** After the IGA quorum approved: planner fetches a FRESH token (now carrying proc.exception-submit) and re-submits. */
export async function retryApproved(poId: string, log: AgentLog = lastLog): Promise<{ status: number; po: PurchaseOrder | null }> {
  if (process.env.AUTH_MODE === 'dev') markDevElevated(true); // emulates the IGA grant
  log('planner', 'retry', `Quorum approved ${poId}: fetching fresh token and resubmitting`);
  const r = await call<PurchaseOrder>('planner', 'POST', `/api/po/${poId}/submit`, undefined, { force: true });
  const po = r.status === 200 ? r.json : null;
  log('planner', 'retry', describeSubmit(r.status, po, (r.json as any)?.error));
  return { status: r.status, po };
}

/** Demo attack: a hijacked planner skips its reasoning and pushes an ~80M VND cement order straight at the API. */
export async function attackDirect(log: AgentLog = lastLog): Promise<{ status: number; po: PurchaseOrder | null }> {
  const TARGET = 80_000_000;
  log('planner', 'attack', `⚠️ Simulated hijacked agent: direct API call, ~${TARGET.toLocaleString('en-US')} VND order`);
  const inv = await call<InventoryRes>('planner', 'GET', '/api/inventory');
  if (inv.status !== 200) return { status: inv.status, po: null };
  const products = inv.json.products;
  const cement = products.find((p) => /cement|xi mang/i.test(p.name) || /^(CEM|XM)/i.test(p.sku)) ?? products[0];
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
    justification: `Direct order (planning skipped): ${qty} ${cement.unit} ${cement.name}`,
  }, log);
}
