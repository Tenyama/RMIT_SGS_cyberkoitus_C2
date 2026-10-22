import type { PoListRes, PurchaseOrder } from '../../../shared/types.ts';
import { getReasoner } from '../llm.ts';
import { call } from './api.ts';
import type { AgentLog } from './index.ts';

/** For blocked / pending POs (of this run when `poIds` given): reasoner.explain → POST exception-report. */
export async function runException(log: AgentLog, poIds?: Set<string>): Promise<number> {
  const pos: PurchaseOrder[] = [];
  for (const status of ['blocked', 'pending_approval'] as const) {
    const r = await call<PoListRes>('exception', 'GET', `/api/po?status=${status}`);
    if (r.status !== 200) {
      log('exception', 'error', `Không đọc được đơn ${status} (HTTP ${r.status})`);
      continue;
    }
    pos.push(...r.json.items.filter((p) => (poIds ? poIds.has(p.id) : !p.exception_report)));
  }
  if (!pos.length) log('exception', 'explain', 'Không có đơn ngoại lệ.');
  let n = 0;
  for (const po of pos) {
    const report = await getReasoner().explain(po);
    const r = await call('exception', 'POST', `/api/po/${po.id}/exception-report`, report);
    if (r.status === 200) {
      n++;
      log('exception', 'report', `📋 ${report.summary} [${report.risk_flags.join(', ')}]`);
    } else {
      log('exception', 'error', `Không gửi được báo cáo cho ${po.id} (HTTP ${r.status})`);
    }
  }
  return n;
}
