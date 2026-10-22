import { RULES, type ChangeRequest, type DecryptBeaconReq } from '../../shared/types.ts';
import { getDb, now } from './db.ts';
import { findActive, openAlert, transition } from './alerts.ts';
import { publish } from './sse.ts';

/** D5: every duration × TIME_SCALE. */
export function timeScale(): number {
  const v = Number(process.env.TIME_SCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
}
export const scaled = (ms: number) => ms * timeScale();

/** Insert one beacon and evaluate decrypt_anomaly (DESIGN §7.4) synchronously (<1s, NFR3). */
export function onBeacon(actor_hash: string, b: DecryptBeaconReq): void {
  const db = getDb();
  const ts = now();
  const count = Math.max(1, Math.floor(Number(b.count) || 1));
  db.prepare('INSERT INTO decrypt_event (actor_hash, actor_detail_ct, tag, ok, count, latency_ms, ts) VALUES (?,?,?,?,?,?,?)').run(
    actor_hash, b.actor_detail_ct ?? null, String(b.tag ?? 'kyc'), b.ok ? 1 : 0, count, Math.max(0, Math.round(Number(b.latency_ms) || 0)), ts,
  );
  const windowMs = scaled(RULES.DECRYPT_WINDOW_MS);
  const { n } = db
    .prepare('SELECT COALESCE(SUM(count),0) AS n FROM decrypt_event WHERE actor_hash = ? AND ok = 1 AND ts > ?')
    .get(actor_hash, ts - windowMs) as { n: number };
  publish({ type: 'decrypt.rate', actor_hash, count_10m: n });
  if (n >= RULES.DECRYPT_THRESHOLD) {
    openAlert('decrypt_anomaly', 'crit', actor_hash, `${n} records decrypted within ${Math.round(windowMs / 1000)}s window`);
  }
}

// ---------- background loop ----------
export interface PollDeps {
  fetchFn?: (url: string) => Promise<Pick<Response, 'ok'>>;
  iga?: { listChangeRequests?: (status?: string) => Promise<ChangeRequest[]> };
  healthUrl?: string;
}

let lastUp: boolean | null = null;
let healthFails = 0;
export function resetRuleState(): void {
  healthFails = 0;
}

async function checkTidecloak(deps: PollDeps): Promise<void> {
  const url = deps.healthUrl ?? process.env.TIDECLOAK_HEALTH_URL ?? 'http://localhost:9000/health/ready';
  const fetchFn = deps.fetchFn ?? ((u: string) => fetch(u, { signal: AbortSignal.timeout(3000) }));
  let up = false;
  try {
    up = (await fetchFn(url)).ok;
  } catch {
    up = false;
  }
  // Publish on change only: at TIME_SCALE=0.01 this loop runs every 50ms.
  if (up !== lastUp) publish({ type: 'tidecloak.health', up, ts: now() });
  lastUp = up;
  if (up) {
    healthFails = 0;
    const a = findActive('tidecloak_down', 'tidecloak');
    if (a?.status === 'open') transition(a.id, 'resolved');
    return;
  }
  healthFails++;
  if (healthFails >= RULES.TIDECLOAK_DOWN_SAMPLES) {
    openAlert('tidecloak_down', 'crit', 'tidecloak', `/health/ready failed ${healthFails}x`);
  }
}

function checkQuorumStale(): void {
  const cutoff = now() - scaled(RULES.QUORUM_STALE_MS);
  const rows = getDb()
    .prepare("SELECT id, change_request_id FROM alert WHERE status = 'pending_quorum' AND updated_at < ?")
    .all(cutoff) as { id: string; change_request_id: string | null }[];
  for (const r of rows) {
    openAlert('quorum_stale', 'warn', r.change_request_id ?? r.id, `change request pending > ${Math.round(scaled(RULES.QUORUM_STALE_MS) / 1000)}s`);
  }
}

async function syncChangeRequests(deps: PollDeps): Promise<void> {
  if (!deps.iga?.listChangeRequests) return;
  const db = getDb();
  const crs = await deps.iga.listChangeRequests();
  for (const cr of crs) {
    const prev = db.prepare('SELECT status, approvals, required FROM change_request_mirror WHERE id = ?').get(cr.id) as
      | { status: string; approvals: number; required: number }
      | undefined;
    if (!prev || prev.status !== cr.status || prev.approvals !== cr.approvals || prev.required !== cr.required) {
      db.prepare(
        `INSERT INTO change_request_mirror (id, status, summary, approvals, required, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, summary=excluded.summary, approvals=excluded.approvals,
         required=excluded.required, updated_at=excluded.updated_at`,
      ).run(cr.id, cr.status, cr.summary ?? null, cr.approvals ?? 0, cr.required ?? 2, cr.updated_at ?? now());
      publish({ type: 'cr.updated', id: cr.id, status: cr.status, approvals: cr.approvals, required: cr.required });
    }
    const st = String(cr.status).toUpperCase();
    const to = st === 'COMMITTED' ? 'resolved' : st === 'DENIED' ? 'denied' : null;
    if (!to) continue;
    const pending = db.prepare("SELECT id FROM alert WHERE status = 'pending_quorum' AND change_request_id = ?").all(cr.id) as { id: string }[];
    for (const a of pending) transition(a.id, to);
    const stale = findActive('quorum_stale', cr.id);
    if (stale?.status === 'open') transition(stale.id, 'resolved');
  }
}

/** One background tick; each check is isolated so one failure doesn't skip the rest. */
export async function pollOnce(deps: PollDeps = {}): Promise<void> {
  for (const step of [() => checkTidecloak(deps), async () => checkQuorumStale(), () => syncChangeRequests(deps)]) {
    try {
      await step();
    } catch (e) {
      console.error('[rules] poll step failed:', (e as Error).message);
    }
  }
}

export function startRules(deps: PollDeps = {}): () => void {
  let running = false;
  const h = setInterval(async () => {
    if (running) return;
    running = true;
    await pollOnce(deps).finally(() => (running = false));
  }, scaled(RULES.POLL_MS));
  return () => clearInterval(h);
}
