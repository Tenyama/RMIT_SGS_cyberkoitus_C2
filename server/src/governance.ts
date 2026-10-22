// Governance watcher (track P3). Polls the IGA change requests opened by openExceptionRequest and
// turns their status into PO outcomes. In real mode (AUTH_MODE=jwt) the ONLY way a CR becomes
// APPROVED is a TideCloak quorum of approvers signing with their Tide enclave in the admin console.
import type { StreamEvent } from '../../shared/types.ts';
import { getChangeRequest, IgaError, trackedChangeRequests, untrackChangeRequest, trackChangeRequest } from './iga.ts';

const APPROVED = new Set(['APPROVED', 'COMMITTED']);
const REJECTED = new Set(['DENIED', 'REJECTED']);

export interface GovernanceOpts {
  onApproved: (poId: string) => void | Promise<void>;
  onRejected: (poId: string) => void | Promise<void>;
  publish?: (ev: StreamEvent) => void;
  intervalMs?: number; // default 3000
}

/** Start polling; returns stop(). */
export function startGovernance(opts: GovernanceOpts): () => void {
  const last = new Map<string, string>(); // crId -> "status|approvals"
  let running = false;

  async function finish(crId: string, poId: string, ok: boolean) {
    untrackChangeRequest(crId); // untrack first: guarantees exactly-once even if the callback throws
    try {
      await (ok ? opts.onApproved(poId) : opts.onRejected(poId));
    } catch (e) {
      console.error(`[governance] ${ok ? 'onApproved' : 'onRejected'}(${poId}) failed:`, e);
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const [crId, t] of trackedChangeRequests()) {
        let status: string;
        let approvals = 0;
        let required = 1;
        if (t.simulated) {
          status = 'APPROVED';
          approvals = required = 1;
        } else {
          try {
            const cr = await getChangeRequest(crId);
            ({ status, approvals, required } = cr);
          } catch (e) {
            if (e instanceof IgaError && e.code === 'ENTITY_VANISHED') status = 'DENIED'; // CR deleted → treat as rejected
            else {
              console.error(`[governance] poll ${crId} failed:`, (e as Error).message);
              continue;
            }
          }
        }
        const key = `${status}|${approvals}`;
        if (last.get(crId) !== key) {
          last.set(crId, key);
          opts.publish?.({ type: 'cr.updated', id: crId, status, approvals, required, po_id: t.poId });
        }
        if (APPROVED.has(status)) await finish(crId, t.poId, true);
        else if (REJECTED.has(status)) await finish(crId, t.poId, false);
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), opts.intervalMs ?? 3000);
  return () => clearInterval(timer);
}

/**
 * OFFLINE DEMO ONLY (AUTH_MODE=dev). Marks the PO's CR as approved so the next governance tick fires
 * onApproved — no TideCloak, no quorum. Real mode REQUIRES the TideCloak quorum; this throws there.
 */
export function simulateApproval(poId: string): { change_request_id: string } {
  if (process.env.AUTH_MODE !== 'dev') throw new Error('simulateApproval is only allowed with AUTH_MODE=dev; real approval needs the TideCloak quorum');
  const found = trackedChangeRequests().find(([, t]) => t.poId === poId);
  const crId = found?.[0] ?? `sim-${poId}`;
  if (!found) trackChangeRequest(crId, poId, 'dev');
  const t = trackedChangeRequests().find(([id]) => id === crId)![1];
  t.simulated = true;
  return { change_request_id: crId };
}
