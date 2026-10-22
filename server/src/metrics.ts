// Prometheus text exposition for GET /api/metrics (DESIGN §7.2). Hand-written, no deps.
import type { NodeState, NodesRes } from '../../shared/types.ts';

const STATES: NodeState[] = ['healthy', 'slow', 'down', 'stale', 'lost'];
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Hist { labels: string; counts: number[]; sum: number; count: number }
const outbound = new Map<string, Hist>();
const cryptoErrors = new Map<string, number>();
let snapshot: () => NodesRes[] = () => [];
let extra: (() => string[]) | null = null;

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const lbl = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(',');

export function resetMetrics(): void {
  outbound.clear();
  cryptoErrors.clear();
}

/** Simulator registers how to read current node state. */
export function setNodeSnapshot(fn: () => NodesRes[]): void {
  snapshot = fn;
}

/** Track C: append extra exposition lines (e.g. tidewatch_decrypt_total). Pass null to clear. */
export function registerExtraMetrics(fn: (() => string[]) | null): void {
  extra = fn;
}

export function observeOutbound(target: string, endpoint: string, status: string, seconds: number): void {
  const labels = lbl({ target, endpoint, status });
  let h = outbound.get(labels);
  if (!h) outbound.set(labels, (h = { labels, counts: BUCKETS.map(() => 0), sum: 0, count: 0 }));
  BUCKETS.forEach((b, i) => { if (seconds <= b) h!.counts[i]++; });
  h.sum += seconds;
  h.count++;
}

export function incCryptoError(type: string, scheme: string, side: string, n = 1): void {
  const labels = lbl({ type, scheme, side });
  cryptoErrors.set(labels, (cryptoErrors.get(labels) ?? 0) + n);
}

export function renderMetrics(): string {
  const out: string[] = [];
  const keys = snapshot();

  out.push('# HELP tidewatch_node_state 1 if the ORK node is in this state for the key', '# TYPE tidewatch_node_state gauge');
  for (const k of keys)
    for (const n of k.nodes)
      for (const s of STATES) out.push(`tidewatch_node_state{${lbl({ key_id: k.key_id, node_id: n.node_id, state: s })}} ${n.state === s ? 1 : 0}`);

  out.push('# HELP tidewatch_key_margin (healthy+slow) - THRESHOLD; < 0 => DoS', '# TYPE tidewatch_key_margin gauge');
  for (const k of keys) out.push(`tidewatch_key_margin{${lbl({ key_id: k.key_id })}} ${k.health.margin}`);

  out.push('# HELP tidewatch_shard_loss_budget MAX_FAULTY - (lost+stale)', '# TYPE tidewatch_shard_loss_budget gauge');
  for (const k of keys) out.push(`tidewatch_shard_loss_budget{${lbl({ key_id: k.key_id })}} ${k.health.budget}`);

  out.push('# HELP tide_ork_outbound_duration_seconds Simulated ORK outbound call latency', '# TYPE tide_ork_outbound_duration_seconds histogram');
  for (const h of outbound.values()) {
    BUCKETS.forEach((b, i) => out.push(`tide_ork_outbound_duration_seconds_bucket{${h.labels},le="${b}"} ${h.counts[i]}`));
    out.push(`tide_ork_outbound_duration_seconds_bucket{${h.labels},le="+Inf"} ${h.count}`);
    out.push(`tide_ork_outbound_duration_seconds_sum{${h.labels}} ${+h.sum.toFixed(6)}`);
    out.push(`tide_ork_outbound_duration_seconds_count{${h.labels}} ${h.count}`);
  }

  out.push('# HELP tide_crypto_errors_total Simulated ORK crypto errors', '# TYPE tide_crypto_errors_total counter');
  for (const [labels, v] of cryptoErrors) out.push(`tide_crypto_errors_total{${labels}} ${v}`);

  if (extra) out.push(...extra());
  return out.join('\n') + '\n';
}
