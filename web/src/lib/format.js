// Pure helpers shared by Dashboard/Audit (unit-tested in src/lib/format.test.js).

const vnd = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });

export const formatVND = (n) => vnd.format(Number(n) || 0);
export const formatNum = (n) => num.format(Number(n) || 0);

// Server timestamps may be epoch seconds or ms; normalise to ms.
export const toMs = (ts) => (ts && ts < 1e12 ? ts * 1000 : ts);
export const formatTime = (ts) =>
  ts ? new Date(toMs(ts)).toLocaleTimeString("vi-VN", { hour12: false }) : "";
export const formatDateTime = (ts) =>
  ts ? new Date(toMs(ts)).toLocaleString("vi-VN", { hour12: false }) : "";

// PO board columns, in display order. `draft` is transient and not shown.
export const PO_COLUMNS = [
  { status: "executed", label: "✅ Tự động thực thi", tone: "ok" },
  { status: "blocked", label: "⛔ Bị chặn", tone: "err" },
  { status: "pending_approval", label: "⏳ Chờ quorum", tone: "warn" },
  { status: "approved", label: "👍 Đã duyệt", tone: "info" },
  { status: "rejected", label: "✗ Từ chối", tone: "muted" },
];

// -> { executed: PO[], blocked: PO[], ... } newest first; unknown statuses dropped.
export function groupPosByStatus(pos) {
  const out = Object.fromEntries(PO_COLUMNS.map((c) => [c.status, []]));
  for (const po of pos || []) if (out[po.status]) out[po.status].push(po);
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
    pending: g.pending_approval.length,
    spent,
    limit: AGENT_DAILY_LIMIT,
    pct: Math.min(100, Math.round((spent / AGENT_DAILY_LIMIT) * 100)),
  };
}

// Insert (at the front) or replace by id.
export function upsertById(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [item, ...list];
  const next = list.slice();
  next[i] = item;
  return next;
}
