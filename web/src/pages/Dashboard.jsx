// Buyer dashboard (track P4): KPIs, demo controls, live agent log, PO board, inventory.
// All data comes from /api/* + SSE /api/stream; the server is the authority, this page only shows it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { openStream } from "../lib/stream.js";
import {
  MAX_LOG_ENTRIES, PO_COLUMNS, STATUS_LINE, computeKpis, formatNum, formatTime, formatVND,
  groupLogsByRun, groupPosByStatus, isSimulatedCr, mergeById, upsertById,
} from "../lib/format.js";

const AGENT_LABEL = { analyst: "Analyst", planner: "Planner", exception: "Exception" };
const STOCK_LABEL = { stockout_risk: "Stockout risk", ok: "OK", overstock: "Overstock" };
const REC_LABEL = { approve: "Recommend approve", reject: "Recommend reject", investigate: "Investigate" };
const TIDE_CONSOLE_URL = "http://localhost:8080/admin/master/console/#/test1";

export default function Dashboard({ getToken }) {
  const tokRef = useRef(getToken);
  tokRef.current = getToken;
  const call = useCallback(
    async (path, opts = {}) => api(path, { ...opts, token: await tokRef.current() }),
    [],
  );

  const [inv, setInv] = useState({ products: [], recommendations: [] });
  const [supNames, setSupNames] = useState({});
  const [pos, setPos] = useState([]);
  const [crs, setCrs] = useState({});
  const [logs, setLogs] = useState([]);
  const [runs, setRuns] = useState({}); // local run key -> { n, runId }
  const [conn, setConn] = useState("connecting");
  const [busy, setBusy] = useState({}); // action id -> true while its request is in flight
  const busyRef = useRef({});
  const runRef = useRef(null); // local key of the latest run; tags incoming agent.log events
  const runCount = useRef(0);
  const logSeq = useRef(0);
  const [injected, setInjected] = useState(false);
  const [notice, setNotice] = useState(null); // { tone, text }

  const loadInventory = useCallback(async () => {
    const r = await call("/inventory");
    setInv({ products: r.products || [], recommendations: r.recommendations || [] });
  }, [call]);

  const loadAll = useCallback(async () => {
    try {
      const [, poRes] = await Promise.all([loadInventory(), call("/po")]);
      setPos((cur) => mergeById(poRes.items, cur));
    } catch (e) {
      setNotice({ tone: "err", text: `Could not load data: ${e.message}` });
    }
  }, [call, loadInventory]);

  useEffect(() => {
    call("/suppliers")
      .then((r) => setSupNames(Object.fromEntries((r.suppliers || []).map((s) => [s.id, s.name]))))
      .catch(() => {});
  }, [call]);

  useEffect(() => {
    loadAll();
    const close = openStream(
      () => tokRef.current(),
      (ev) => {
        switch (ev.type) {
          case "po.updated":
            setPos((list) => upsertById(list, ev.po));
            break;
          case "agent.log": {
            const key = ++logSeq.current;
            setLogs((l) => [...l, { ...ev, key, run: runRef.current || "live" }].slice(-MAX_LOG_ENTRIES));
            break;
          }
          case "cr.updated":
            setCrs((m) => ({ ...m, [ev.id]: ev }));
            break;
          case "inventory.updated":
            // Event carries products only; refetch to get the deterministic recommendations too.
            loadInventory().catch(() => {});
            break;
          default:
        }
      },
      setConn,
    );
    return close;
  }, [call, loadAll, loadInventory]);

  // Runs one POST per action id at a time; the ref guards against double clicks before re-render.
  const act = async (id, path, body, okText) => {
    if (busyRef.current[id]) return null;
    busyRef.current = { ...busyRef.current, [id]: true };
    setBusy(busyRef.current);
    setNotice(null);
    try {
      const r = await call(path, { method: "POST", body: body ?? {} });
      if (okText) setNotice({ tone: "ok", text: okText(r) });
      return r ?? {};
    } catch (e) {
      setNotice({ tone: "err", text: `${path}: ${e.status ? `${e.status} — ` : ""}${e.message}` });
      return null;
    } finally {
      const { [id]: _, ...rest } = busyRef.current;
      busyRef.current = rest;
      setBusy(rest);
    }
  };

  const runAgents = async () => {
    if (busyRef.current.run) return;
    const n = ++runCount.current;
    const key = `run-${n}`;
    runRef.current = key;
    setRuns((m) => ({ ...m, [key]: { n } }));
    const r = await act("run", "/agents/run", {}, (res) => `AI agents started (run ${res?.run_id ?? "?"})`);
    if (r?.run_id) setRuns((m) => ({ ...m, [key]: { n, runId: r.run_id } }));
  };
  const toggleInject = async () => {
    const next = !injected;
    const r = await act("inject", "/demo/inject", { enabled: next }, () =>
      next
        ? "Malicious note injected into the unapproved supplier's offer"
        : "Malicious note removed",
    );
    if (r !== null) setInjected(next);
  };
  const attack = async () => {
    const r = await act("attack", "/demo/attack", {}, (res) => {
      const po = res?.po ?? res;
      return po?.status
        ? `Hijacked agent called the API directly: ${formatVND(po.total)} → "${po.status}" (decided by the server, not the agent)`
        : "Attack request sent";
    });
    const po = r?.po ?? r;
    if (po?.id) setPos((list) => upsertById(list, po));
  };
  const reset = async () => {
    const r = await act("reset", "/demo/reset", {}, () => "Demo data reset");
    if (r !== null) {
      setLogs([]);
      setRuns({});
      setCrs({});
      setInjected(false);
      setPos([]);
      runRef.current = null;
      loadAll();
    }
  };
  const simApprove = (po) =>
    act(`approve-${po.id}`, `/demo/approve/${encodeURIComponent(po.id)}`, {}, () =>
      `Simulated quorum approval for ${po.id} — the planner will re-submit`,
    );

  const recBySku = useMemo(
    () => Object.fromEntries(inv.recommendations.map((r) => [r.sku, r])),
    [inv.recommendations],
  );
  const nameBySku = useMemo(() => Object.fromEntries(inv.products.map((p) => [p.sku, p.name])), [inv.products]);
  const groups = useMemo(() => groupPosByStatus(pos), [pos]);
  const kpi = useMemo(() => computeKpis(pos), [pos]);
  const anyBusy = Object.keys(busy).length > 0;

  return (
    <div className="dash">
      <section className="kpis">
        <Kpi label="Auto-executed" value={kpi.executed} tone="ok" />
        <Kpi label="Blocked" value={kpi.blocked} tone="err" />
        <Kpi label="Awaiting quorum" value={kpi.pending} tone="warn" />
        <div className="kpi spend">
          <div className="kpi-label">Agent spend today</div>
          <div className="kpi-value">
            {formatVND(kpi.spent)} <span className="kpi-of">/ {formatVND(kpi.limit)}</span>
          </div>
          <div className="bar" role="progressbar" aria-valuenow={kpi.pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={`bar-fill ${kpi.pct >= 90 ? "hot" : ""}`} style={{ width: `${kpi.pct}%` }} />
          </div>
        </div>
      </section>

      <section className="controls">
        <ActionButton className="btn primary" busy={busy.run} disabled={busy.reset} onClick={runAgents}>
          Run AI agents
        </ActionButton>
        <ActionButton
          className={`btn toggle ${injected ? "on" : ""}`}
          busy={busy.inject}
          disabled={busy.reset}
          onClick={toggleInject}
          aria-pressed={injected}
        >
          Poison supplier data: {injected ? "ON" : "OFF"}
        </ActionButton>
        <ActionButton className="btn danger-outline" busy={busy.attack} disabled={busy.reset} onClick={attack}>
          Hijacked agent: direct API call (80M)
        </ActionButton>
        <ActionButton className="btn ghost" busy={busy.reset} disabled={anyBusy && !busy.reset} onClick={reset}>
          Reset demo
        </ActionButton>
        <span className={`live ${conn === "open" ? "on" : ""}`}>
          <span className="dot" /> {conn === "open" ? "Live" : conn === "connecting" ? "Connecting…" : "Offline"}
        </span>
      </section>
      {notice && <div className={`alert ${notice.tone}`}>{notice.text}</div>}

      <div className="main-grid">
        <section className="panel log-panel">
          <div className="panel-head">
            <h2>Agent log</h2>
            <span className="muted small">newest first · last {MAX_LOG_ENTRIES}</span>
          </div>
          <AgentLog logs={logs} runs={runs} />
        </section>

        <section className="panel board-panel">
          <div className="panel-head">
            <h2>Purchase orders</h2>
            <span className="muted small">{pos.length} total</span>
          </div>
          <div className="board">
            {PO_COLUMNS.map((c) => (
              <div key={c.id} className={`col ${c.tone}`}>
                <div className="col-head">
                  <span>{c.label}</span> <span className="count">{groups[c.id].length}</span>
                </div>
                {!groups[c.id].length && <div className="col-empty">No orders</div>}
                {groups[c.id].map((po) => (
                  <PoCard
                    key={po.id}
                    po={po}
                    name={nameBySku[po.sku]}
                    supplier={supNames[po.supplier_id] ?? po.supplier_id}
                    cr={crs[po.change_request_id]}
                    approving={!!busy[`approve-${po.id}`]}
                    onSimApprove={() => simApprove(po)}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>

      <details className="panel inv-panel">
        <summary>
          <h2>Inventory &amp; reorder points</h2>
          <span className="muted small">{inv.products.length} SKUs</span>
        </summary>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th><th>Product</th><th className="num">On hand</th><th className="num">On order</th>
                <th className="num">Demand/day</th><th className="num">Reorder point</th>
                <th className="num">Recommended</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {inv.products.map((p) => {
                const r = recBySku[p.sku];
                return (
                  <tr key={p.sku}>
                    <td><code>{p.sku}</code></td>
                    <td>{p.name}</td>
                    <td className="num">{formatNum(p.on_hand)} <span className="muted small">{p.unit}</span></td>
                    <td className="num">{formatNum(p.on_order)}</td>
                    <td className="num">{formatNum(p.avg_daily_demand)}</td>
                    <td className="num">{r ? formatNum(r.reorder_point) : "—"}</td>
                    <td className="num"><b>{r ? formatNum(r.recommended_qty) : "—"}</b></td>
                    <td>{r && <span className={`chip ${r.status}`}>{STOCK_LABEL[r.status] ?? r.status}</span>}</td>
                  </tr>
                );
              })}
              {!inv.products.length && (
                <tr><td colSpan={8} className="muted">No inventory data yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function ActionButton({ busy, disabled, children, className, ...rest }) {
  return (
    <button className={className} disabled={!!busy || !!disabled} aria-busy={!!busy} {...rest}>
      {busy ? <><span className="spinner" aria-hidden="true" /> Running…</> : children}
    </button>
  );
}

function Kpi({ label, value, tone }) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}

function AgentLog({ logs, runs }) {
  const groups = useMemo(() => groupLogsByRun(logs), [logs]);
  if (!logs.length) {
    return <div className="empty">Click <b>Run AI agents</b> to watch the agents reason and act.</div>;
  }
  return (
    <div className="timeline">
      {groups.map((g) => {
        const r = runs[g.run];
        return (
          <div key={g.run} className="run">
            <div className="run-head">
              <span>{r ? `Run #${r.n}` : "Live events"}</span>
              {r?.runId && <code className="muted">{r.runId}</code>}
              <span className="muted small">{formatTime(g.startedAt)}</span>
            </div>
            {g.entries.map((l) => <LogEntry key={l.key} l={l} />)}
          </div>
        );
      })}
    </div>
  );
}

function LogEntry({ l }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`entry ${open ? "open" : ""} ${l.step === "error" ? "is-error" : ""}`}
      onClick={() => setOpen((o) => !o)}
      title={open ? "Click to collapse" : "Click to expand"}
    >
      <span className={`agent-pill ${l.agent}`}>{AGENT_LABEL[l.agent] ?? l.agent}</span>
      {l.step && <span className="step-tag">{l.step}</span>}
      <span className="entry-msg">{l.message}</span>
      <span className="entry-time">{formatTime(l.ts)}</span>
    </div>
  );
}

function PoCard({ po, name, supplier, cr, approving, onSimApprove }) {
  const [details, setDetails] = useState(false);
  const checks = po.checks || [];
  const failed = checks.filter((c) => !c.ok);
  const rep = po.exception_report;
  const pending = po.status === "pending_approval";
  return (
    <article className={`po s-${po.status}`}>
      <div className="po-head">
        <code className="po-sku">{po.sku}</code>
        <span className="po-total">{formatVND(po.total)}</span>
      </div>
      {name && <div className="po-name">{name}</div>}
      <div className="po-meta">
        <span title={po.supplier_id}>{supplier}</span>
        <span className="muted">{formatNum(po.qty)} × {formatVND(po.unit_price)}</span>
      </div>
      <div className="po-status">{STATUS_LINE[po.status] ?? po.status}</div>

      {checks.length > 0 && failed.length === 0 && (
        <div className="checks-ok">{checks.length}/{checks.length} rules passed ✓</div>
      )}
      {failed.length > 0 && (
        <ul className="checks fail">
          {failed.map((c, i) => (
            <li key={`${c.rule}-${i}`}><b>{c.rule}</b> <span>{c.detail}</span></li>
          ))}
        </ul>
      )}

      {rep && (
        <div className="callout">
          <div className="callout-head">Exception report · <b>{REC_LABEL[rep.recommendation] ?? rep.recommendation}</b></div>
          <div className="callout-body">{rep.summary}</div>
          {rep.risk_flags?.length > 0 && (
            <div className="flags">{rep.risk_flags.map((f) => <span key={f} className="flag">{f}</span>)}</div>
          )}
        </div>
      )}

      {pending && po.change_request_id && (
        <div className="cta">
          <div className="cta-info">
            <span className="muted small">Change request</span> <code>{po.change_request_id}</code>
            <span className="cta-q">
              {cr?.required != null ? `${cr.approvals ?? 0}/${cr.required} approvals` : "awaiting approvals"}
            </span>
          </div>
          {isSimulatedCr(po.change_request_id) ? (
            <button className="btn small-btn primary" disabled={approving} onClick={onSimApprove}>
              {approving ? <><span className="spinner" aria-hidden="true" /> Running…</> : "Simulate quorum approval (dev)"}
            </button>
          ) : (
            <a className="btn small-btn primary" href={TIDE_CONSOLE_URL} target="_blank" rel="noopener noreferrer">
              Approve in TideCloak
            </a>
          )}
        </div>
      )}
      {!pending && po.change_request_id && (
        <div className="muted small">CR <code>{po.change_request_id}</code>{cr?.status ? ` · ${cr.status}` : ""}</div>
      )}

      <button className="link-btn" onClick={() => setDetails((d) => !d)} aria-expanded={details}>
        {details ? "Hide details" : "Details"}
      </button>
      {details && (
        <div className="po-details">
          <div className="small muted">PO {po.id} · created by {po.created_by}</div>
          {po.justification && (
            <div className="untrusted">
              <div className="untrusted-label">AI rationale (untrusted)</div>
              <div>{po.justification}</div>
            </div>
          )}
          {checks.length > 0 && (
            <ul className="checks all">
              {checks.map((c, i) => (
                <li key={`${c.rule}-${i}`} className={c.ok ? "pass" : "fail"}>
                  <span className="mark">{c.ok ? "✓" : "✗"}</span> <b>{c.rule}</b> <span>{c.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}
