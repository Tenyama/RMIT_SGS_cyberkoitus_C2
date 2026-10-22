// STUB — replaced by track D on merge. Matches the seam in docs/CONTRACTS.md "Module seams".
import type { Hono } from 'hono';
import { MAX_FAULTY, SWARM_SIZE, THRESHOLD, type ChaosReq, type NodesRes, type StreamEvent } from '../../shared/types.ts';

export function getNodes(key_id: string): NodesRes {
  return { key_id, nodes: [], health: { key_id, margin: SWARM_SIZE - THRESHOLD, budget: MAX_FAULTY, dos: false } };
}

export function chaos(req: ChaosReq): NodesRes {
  return getNodes(req.key_id ?? 'kyc-key');
}

export function tick(_now: number): StreamEvent[] {
  return [];
}

export function registerSimRoutes(_app: Hono<any>): void {}
