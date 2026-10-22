import type { InventoryRes } from '../../../shared/types.ts';
import { getReasoner, type RiskItem } from '../llm.ts';
import { call } from './api.ts';
import type { AgentLog } from './index.ts';

/** GET /api/inventory as agent-analyst → reasoner.analyze → one log line per at-risk SKU. */
export async function runAnalyst(log: AgentLog): Promise<RiskItem[]> {
  const r = await call<InventoryRes>('analyst', 'GET', '/api/inventory');
  if (r.status !== 200) {
    log('analyst', 'error', `Không đọc được tồn kho (HTTP ${r.status}): ${(r.json as any)?.error ?? ''}`.trim());
    return [];
  }
  const items = await getReasoner().analyze(r.json.recommendations, r.json.products);
  if (!items.length) log('analyst', 'analyze', 'Không có SKU nào rủi ro.');
  for (const it of items) log('analyst', 'analyze', `${it.risk === 'stockout_risk' ? '⚠️' : 'ℹ️'} ${it.rationale}`);
  return items;
}
