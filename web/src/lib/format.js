// Pure helpers shared by Dashboard/Audit/Approver (unit-tested in src/lib/format.test.js).

const num0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export const formatVND = (n) => `${num0.format(Math.round(Number(n) || 0))} VND`;
export const formatNum = (n) => num1.format(Number(n) || 0);

// Server timestamps may be epoch seconds or ms; normalise to ms.
export const toMs = (ts) => (ts && ts < 1e12 ? ts * 1000 : ts);
export const formatTime = (ts) =>
  ts ? new Date(toMs(ts)).toLocaleTimeString("en-GB", { hour12: false }) : "";
export const formatDateTime = (ts) =>
  ts ? new Date(toMs(ts)).toLocaleString("en-GB", { hour12: false }) : "";

// PO board columns, in display order. `draft` is transient and not shown.
export const PO_COLUMNS = [
  { id: "executed", statuses: ["executed"], label: "Auto-executed", tone: "ok" },
  { id: "blocked", statuses: ["blocked"], label: "Blocked", tone: "err" },
  { id: "pending", statuses: ["pending_approval"], label: "Awaiting quorum", tone: "warn" },
  { id: "resolved", statuses: ["approved", "rejected"], label: "Resolved", tone: "info" },
];

// One-line status shown on each PO card.
export const STATUS_LINE = {
  executed: "Executed — order sent to supplier",
  blocked: "Blocked by policy — cannot be approved",
  pending_approval: "Over agent authority — needs quorum approval",
  approved: "Quorum approved — waiting for re-submit",
  rejected: "Rejected by approvers",
  draft: "Draft",
};

// -> { executed: PO[], blocked: PO[], pending: PO[], resolved: PO[] } newest first; unknown statuses dropped.
export function groupPosByStatus(pos) {
  const out = Object.fromEntries(PO_COLUMNS.map((c) => [c.id, []]));
  const colOf = Object.fromEntries(PO_COLUMNS.flatMap((c) => c.statuses.map((s) => [s, c.id])));
  for (const po of pos || []) if (colOf[po.status]) out[colOf[po.status]].push(po);
  for (const k of Object.keys(out)) out[k].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return out;
}

export const AGENT_DAILY_LIMIT = 30_000_000; // mirrors POLICY.AGENT_DAILY_LIMIT in shared/types.ts

const sameDay = (a, b) => {
  const x = new Date(toMs(a));
  const y = new Date(toMs(b));
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};

// KPI strip. "Spent" = executed orders created by an agent, updated today.
export function computeKpis(pos, now = Date.now()) {
  const g = groupPosByStatus(pos);
  const spent = g.executed
    .filter((p) => String(p.created_by || "").startsWith("agent") && sameDay(p.updated_at || p.created_at, now))
    .reduce((s, p) => s + (Number(p.total) || 0), 0);
  return {
    executed: g.executed.length,
    blocked: g.blocked.length,
    pending: g.pending.length,
    spent,
    limit: AGENT_DAILY_LIMIT,
    pct: Math.min(100, Math.round((spent / AGENT_DAILY_LIMIT) * 100)),
  };
}

// Insert (at the front) or replace by id.
export function upsertById(list, item) {
  if (!item || item.id == null) return list;
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [item, ...list];
  const next = list.slice();
  next[i] = item;
  return next;
}

// Merge a fetched list with what SSE already delivered: one entry per id, newer updated_at wins.
export function mergeById(fetched, current) {
  const m = new Map();
  for (const x of [...(fetched || []), ...(current || [])]) {
    if (!x || x.id == null) continue;
    const prev = m.get(x.id);
    if (!prev || (x.updated_at || 0) >= (prev.updated_at || 0)) m.set(x.id, x);
  }
  return [...m.values()];
}

// Simulated quorum (server AUTH_MODE=dev + SIM_QUORUM=1) uses change request ids "sim-<po id>".
export const isSimulatedCr = (id) => String(id || "").startsWith("sim-");

// Agent log: entries are { key, run, agent, step, message, ts }. Keep the newest `max` entries and
// return runs newest-first, each with its entries newest-first.
export const MAX_LOG_ENTRIES = 40;
export function groupLogsByRun(logs, max = MAX_LOG_ENTRIES) {
  const kept = (logs || []).slice(-max);
  const runs = [];
  const byRun = new Map();
  for (const l of kept) {
    const id = l.run || "live";
    let r = byRun.get(id);
    if (!r) {
      r = { run: id, startedAt: l.ts, entries: [] };
      byRun.set(id, r);
      runs.push(r);
    }
    r.entries.push(l);
  }
  for (const r of runs) r.entries.reverse();
  return runs.reverse();
}
