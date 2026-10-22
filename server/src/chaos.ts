// Chaos conditions + per-tick sampling for the simulated ORK swarm (DESIGN §9.2, CONTRACTS D4).
import type { ChaosReq } from '../../shared/types.ts';

export type Condition = 'timeout' | 'slow' | 'verify_fail';
export type Outcome = 'ok' | 'timeout' | 'verify_failed';

export interface Request { latency_ms: number; status: '200' | '504'; outcome: Outcome }
export interface Sample { outcome: Outcome; p95_ms: number | null; requests: Request[] }

export const REQUESTS_PER_SAMPLE = 20;
export const TIMEOUT_MS = 5_000;
const ACTION_TO_CONDITION: Record<ChaosReq['action'], Condition | null> = {
  kill: 'timeout',
  slow: 'slow',
  stale: 'verify_fail',
  revive: null,
};

export const CHAOS_ACTIONS = Object.keys(ACTION_TO_CONDITION) as ChaosReq['action'][];

export function isSimulatorOn(): boolean {
  return process.env.SIMULATOR === 'on';
}

/** Mutates `conds` (node_id -> forced condition) for the given chaos action. */
export function applyChaos(conds: Map<string, Condition>, action: ChaosReq['action'], nodeIds: string[]): void {
  const c = ACTION_TO_CONDITION[action];
  for (const id of nodeIds) {
    if (c) conds.set(id, c);
    else conds.delete(id);
  }
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

/** One poll sample = REQUESTS_PER_SAMPLE simulated outbound calls to the node. */
export function sampleNode(cond: Condition | undefined, random: () => number): Sample {
  const requests: Request[] = [];
  for (let i = 0; i < REQUESTS_PER_SAMPLE; i++) {
    const r = random();
    if (cond === 'timeout') requests.push({ latency_ms: TIMEOUT_MS, status: '504', outcome: 'timeout' });
    else if (cond === 'slow') requests.push({ latency_ms: Math.round(2_600 + r * 900), status: '200', outcome: 'ok' });
    else requests.push({ latency_ms: Math.round(60 + r * 300), status: '200', outcome: cond === 'verify_fail' ? 'verify_failed' : 'ok' });
  }
  const outcome: Outcome = cond === 'timeout' ? 'timeout' : cond === 'verify_fail' ? 'verify_failed' : 'ok';
  return { outcome, p95_ms: outcome === 'timeout' ? null : p95(requests.map((q) => q.latency_ms)), requests };
}
