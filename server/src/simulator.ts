// In-process simulated ORK swarm (CONTRACTS D4/D5, DESIGN §7.3, §9.2).
// Each tick = one poll sample per node; state changes only after N consecutive samples (NFR6).
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import {
  DEFAULT_KEY_ID, MAX_FAULTY, RULES, ROLES, SWARM_SIZE, THRESHOLD,
  type AlertKind, type AlertSeverity, type ChaosReq, type KeyHealth, type NodeRow, type NodeState, type NodesRes, type StreamEvent,
} from '../../shared/types.ts';
import { applyChaos, CHAOS_ACTIONS, isSimulatorOn, sampleNode, type Condition, type Sample } from './chaos.ts';
import { incCryptoError, observeOutbound, renderMetrics, resetMetrics, setNodeSnapshot } from './metrics.ts';

export interface SimAlert { kind: AlertKind; severity: AlertSeverity; subject: string; detail: string }
export interface SimOptions {
  publish?: (ev: StreamEvent) => void;
  openAlert?: (a: SimAlert) => void;
  now?: () => number;
  timeScale?: number; // default env TIME_SCALE or 1
  random?: () => number;
}

export const NODE_IDS = Array.from({ length: SWARM_SIZE }, (_, i) => `ork-${String(i + 1).padStart(2, '0')}`);
export const ERR_VERIFY = 'TIDE-ORK-SIG-VERIFY_FAILED';
export const ERR_TIMEOUT = 'TIDE-ORK-TIMEOUT';
const ENDPOINT = '/Authentication/Sign';
const KEYS = [DEFAULT_KEY_ID];

interface Counters { timeout: number; verify: number; ok: number; high: number; low: number }
type Level = 0 | 1 | 2; // none / warn / crit

let db: Database.Database | null = null;
let publish: (ev: StreamEvent) => void = () => {};
let openAlert: (a: SimAlert) => void = () => {};
let nowFn: () => number = Date.now;
let random: () => number = Math.random;
let timeScale = 1;
const conds = new Map<string, Map<string, Condition>>(); // key_id -> node_id -> condition
const counters = new Map<string, Counters>(); // `${key}|${node}`
const marginLevel = new Map<string, Level>();
const budgetLevel = new Map<string, Level>();

const zero = (): Counters => ({ timeout: 0, verify: 0, ok: 0, high: 0, low: 0 });
const ck = (k: string, n: string) => `${k}|${n}`;

export function tickMs(): number {
  return RULES.POLL_MS * timeScale;
}

function requireDb(): Database.Database {
  if (!db) throw new Error('simulator not initialised: call initSimulator(db) first');
  return db;
}

export function initSimulator(handle: Database.Database, opts: SimOptions = {}): void {
  db = handle;
  publish = opts.publish ?? (() => {});
  openAlert = opts.openAlert ?? (() => {});
  nowFn = opts.now ?? Date.now;
  random = opts.random ?? Math.random;
  const envScale = Number(process.env.TIME_SCALE);
  timeScale = opts.timeScale ?? (Number.isFinite(envScale) && envScale > 0 ? envScale : 1);
  conds.clear();
  counters.clear();
  resetMetrics();
  const ins = db.prepare('INSERT OR IGNORE INTO node_state (key_id, node_id, state, since, p95_ms, last_error) VALUES (?, ?, ?, ?, NULL, NULL)');
  const t = nowFn();
  db.transaction(() => { for (const k of KEYS) for (const n of NODE_IDS) ins.run(k, n, 'healthy', t); })();
  for (const k of KEYS) {
    const h = getNodes(k).health;
    marginLevel.set(k, marginLvl(h));
    budgetLevel.set(k, budgetLvl(h));
  }
  setNodeSnapshot(() => KEYS.map(getNodes));
}

export function computeHealth(key_id: string, nodes: Pick<NodeRow, 'state'>[]): KeyHealth {
  const c = (s: NodeState) => nodes.filter((n) => n.state === s).length;
  const margin = c('healthy') + c('slow') - THRESHOLD;
  const budget = MAX_FAULTY - (c('lost') + c('stale'));
  return { key_id, margin, budget, dos: margin < 0 };
}

export function getNodes(key_id: string = DEFAULT_KEY_ID): NodesRes {
  const nodes = requireDb()
    .prepare('SELECT key_id, node_id, state, since, p95_ms, last_error FROM node_state WHERE key_id = ? ORDER BY node_id')
    .all(key_id) as NodeRow[];
  return { key_id, nodes, health: computeHealth(key_id, nodes) };
}

export function chaos(req: ChaosReq): NodesRes {
  const key = req.key_id ?? DEFAULT_KEY_ID;
  if (!conds.has(key)) conds.set(key, new Map());
  applyChaos(conds.get(key)!, req.action, req.node_ids);
  return getNodes(key);
}

function marginLvl(h: KeyHealth): Level {
  return h.margin <= RULES.MARGIN_CRIT ? 2 : h.margin <= RULES.MARGIN_WARN ? 1 : 0;
}
function budgetLvl(h: KeyHealth): Level {
  return h.budget <= RULES.BUDGET_CRIT ? 2 : 0;
}

/** Next state for one node given its updated counters, or null to stay. */
function nextState(n: NodeRow, c: Counters, now: number): { to: NodeState; reason: string } | null {
  const N = RULES.CONSECUTIVE_SAMPLES;
  if (n.state !== 'stale' && n.state !== 'lost' && c.verify >= N) return { to: 'stale', reason: `verify_failed x${c.verify}` };
  switch (n.state) {
    case 'healthy':
      if (c.timeout >= N) return { to: 'down', reason: `timeout x${c.timeout}` };
      if (c.high >= N) return { to: 'slow', reason: `p95>${RULES.SLOW_P95_MS}ms x${c.high}` };
      return null;
    case 'slow':
      if (c.timeout >= N) return { to: 'down', reason: `timeout x${c.timeout}` };
      if (c.low >= N) return { to: 'healthy', reason: `p95<${RULES.SLOW_RECOVER_P95_MS}ms x${c.low}` };
      return null;
    case 'down':
      if (c.ok >= N) return { to: 'healthy', reason: `ok x${c.ok}` };
      if (now - n.since > RULES.DOWN_TO_LOST_MS * timeScale) return { to: 'lost', reason: `down > ${RULES.DOWN_TO_LOST_MS * timeScale}ms` };
      return null;
    case 'stale':
    case 'lost': // [inferred] lost recovers like stale (re-shared) so the demo can be reset
      if (c.ok >= RULES.STALE_RECOVER_OK) return { to: 'healthy', reason: `ok x${c.ok}` };
      return null;
  }
}

function count(c: Counters, s: Sample): void {
  if (s.outcome === 'timeout') { Object.assign(c, zero(), { timeout: c.timeout + 1 }); return; }
  if (s.outcome === 'verify_failed') { Object.assign(c, zero(), { verify: c.verify + 1 }); return; }
  const p = s.p95_ms!;
  c.timeout = 0; c.verify = 0; c.ok++;
  c.high = p > RULES.SLOW_P95_MS ? c.high + 1 : 0;
  c.low = p < RULES.SLOW_RECOVER_P95_MS ? c.low + 1 : 0;
}

export function tick(now: number = nowFn()): StreamEvent[] {
  const d = requireDb();
  const events: StreamEvent[] = [];
  const upd = d.prepare('UPDATE node_state SET state = ?, since = ?, p95_ms = ?, last_error = ? WHERE key_id = ? AND node_id = ?');
  const evIns = d.prepare('INSERT INTO node_event (key_id, node_id, from_state, to_state, reason, ts) VALUES (?, ?, ?, ?, ?, ?)');

  for (const key of KEYS) {
    const kc = conds.get(key);
    let changed = false;
    d.transaction(() => {
      for (const n of getNodes(key).nodes) {
        const s = sampleNode(kc?.get(n.node_id), random);
        for (const r of s.requests) observeOutbound(n.node_id, ENDPOINT, r.status, r.latency_ms / 1000);
        if (s.outcome === 'verify_failed') incCryptoError('verify_failed', 'EdDSA', 'ork', s.requests.length);

        const cKey = ck(key, n.node_id);
        const c = counters.get(cKey) ?? zero();
        counters.set(cKey, c);
        count(c, s);

        const next = nextState(n, c, now);
        let state = n.state, since = n.since, err = n.last_error;
        if (next) {
          state = next.to;
          since = now;
          err = next.to === 'stale' ? ERR_VERIFY : next.to === 'down' ? ERR_TIMEOUT : next.to === 'healthy' ? null : err;
          counters.set(cKey, zero());
          evIns.run(key, n.node_id, n.state, state, next.reason, now);
          events.push({ type: 'node.state', key_id: key, node_id: n.node_id, from: n.state, to: state, ts: now });
          changed = true;
        }
        upd.run(state, since, s.p95_ms ?? n.p95_ms, err, key, n.node_id);
      }
    })();

    if (changed) {
      const h = getNodes(key).health;
      events.push({ type: 'key.margin', key_id: key, margin: h.margin, budget: h.budget, dos: h.dos, ts: now });
      raiseAlerts(h);
    }
  }
  for (const e of events) publish(e);
  return events;
}

function raiseAlerts(h: KeyHealth): void {
  const ml = marginLvl(h);
  if (ml > (marginLevel.get(h.key_id) ?? 0))
    openAlert({ kind: 'key_margin', severity: ml === 2 ? 'crit' : 'warn', subject: h.key_id, detail: `margin=${h.margin} budget=${h.budget}${h.dos ? ' DoS' : ''}` });
  marginLevel.set(h.key_id, ml);
  const bl = budgetLvl(h);
  if (bl > (budgetLevel.get(h.key_id) ?? 0))
    openAlert({ kind: 'shard_loss', severity: 'crit', subject: h.key_id, detail: `budget=${h.budget} (lost+stale=${MAX_FAULTY - h.budget})` });
  budgetLevel.set(h.key_id, bl);
}

/** Starts the poll loop (every POLL_MS × TIME_SCALE). Returns stop(). */
export function startSimulator(): () => void {
  const t = setInterval(() => {
    try { tick(nowFn()); } catch (e) { console.error('[simulator] tick failed', e); }
  }, tickMs());
  t.unref?.();
  return () => clearInterval(t);
}

function allowed(c: any, roles: string[]): boolean {
  const have = c.get('roles') as string[] | undefined;
  return !have || roles.some((r) => have.includes(r));
}

export function registerSimRoutes(app: Hono<any>): void {
  app.get('/api/nodes', (c) => {
    if (!allowed(c, [ROLES.PLATFORM, ROLES.MONITOR])) return c.json({ error: 'forbidden' }, 403);
    const key = c.req.query('key_id') ?? DEFAULT_KEY_ID;
    if (!KEYS.includes(key)) return c.json({ error: 'unknown key_id' }, 404);
    return c.json(getNodes(key));
  });

  app.post('/api/chaos', async (c) => {
    if (!isSimulatorOn()) return c.json({ error: 'simulator disabled', code: 'SIMULATOR_OFF' }, 403);
    if (!allowed(c, [ROLES.PLATFORM])) return c.json({ error: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => null)) as Partial<ChaosReq> | null;
    const key = body?.key_id ?? DEFAULT_KEY_ID;
    if (
      !body || !CHAOS_ACTIONS.includes(body.action as ChaosReq['action']) || !Array.isArray(body.node_ids) ||
      !body.node_ids.every((id) => NODE_IDS.includes(id)) || !KEYS.includes(key)
    ) return c.json({ error: 'bad chaos request' }, 400);
    return c.json(chaos({ action: body.action!, node_ids: body.node_ids, key_id: key }));
  });

  app.get('/api/metrics', (c) => c.body(renderMetrics(), 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }));
}
