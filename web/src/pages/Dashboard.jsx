// Buyer dashboard (track P4): inventory, demo controls, live agent log, PO board, KPIs.
// All data comes from /api/* + SSE /api/stream; the server is the authority, this page only shows it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { openStream } from "../lib/stream.js";
import {
  PO_COLUMNS, computeKpis, formatNum, formatTime, formatVND, groupPosByStatus, upsertById,
} from "../lib/format.js";

const AGENT_LABEL = { analyst: "Analyst", planner: "Planner", exception: "Exception" };
const STOCK_LABEL = { stockout_risk: "Nguy cơ hết hàng", ok: "Ổn định", overstock: "Tồn dư" };
const REC_LABEL = { approve: "Đề xuất duyệt", reject: "Đề xuất từ chối", investigate: "Cần điều tra" };
const MAX_LOGS = 400;

export default function Dashboard({ getToken }) {
  const tokRef = useRef(getToken);
  tokRef.current = getToken;
  const call = useCallback(
    async (path, opts = {}) => api(path, { ...opts, token: await tokRef.current() }),
    [],
  );

  const [inv, setInv] = useState({ products: [], recommendations: [] });
  const [pos, setPos] = useState([]);
  const [crs, setCrs] = useState({});
  const [logs, setLogs] = useState([]);
  const [conn, setConn] = useState("connecting");
  const [busy, setBusy] = useState(null);
  const [injected, setInjected] = useState(false);
  const [notice, setNotice] = useState(null); // { tone, text }

  const loadInventory = useCallback(async () => {
    const r = await call("/inventory");
    setInv({ products: r.products || [], recommendations: r.recommendations || [] });
  }, [call]);

  const loadAll = useCallback(async () => {
    try {
      const [, poRes] = await Promise.all([loadInventory(), call("/po")]);
      setPos(poRes.items || []);
    } catch (e) {
      setNotice({ tone: "err", text: `Không tải được dữ liệu: ${e.message}` });
    }
  }, [call, loadInventory]);

  useEffect(() => {
    loadAll();
    const close = openStream(
      () => tokRef.current(),
      (ev) => {
        switch (ev.type) {
          case "po.updated":
            setPos((list) => upsertById(list, ev.po));
            break;
          case "agent.log":
            setLogs((l) => [...l, { ...ev, key: `${ev.ts}-${l.length}` }].slice(-MAX_LOGS));
            break;
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
  }, [loadAll, loadInventory]);

  const act = async (id, path, body, okText) => {
    setBusy(id);
    setNotice(null);
    try {
      const r = await call(path, { method: "POST", body: body ?? {} });
      setNotice({ tone: "ok", text: okText(r) });
      return r;
    } catch (e) {
      setNotice({ tone: "err", text: `${path}: ${e.status ? `${e.status} — ` : ""}${e.message}` });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const runAgents = () => act("run", "/agents/run", {}, (r) => `Đã khởi chạy AI agents (run ${r?.run_id ?? "?"})`);
  const toggleInject = async () => {
    const next = !injected;
    const r = await act("inject", "/demo/inject", { enabled: next }, () =>
      next ? "☠ Đã chèn ghi chú độc vào báo giá nhà cung cấp chưa duyệt" : "Đã gỡ ghi chú độc",
    );
    if (r !== null) setInjected(next);
  };
  const attack = async () => {
    const r = await act("attack", "/demo/attack", {}, (res) => {
      const po = res?.po ?? res;
      return po?.status
        ? `⚡ Agent gọi thẳng API: ${formatVND(po.total)} → trạng thái “${po.status}” (server quyết định, không phải agent)`
        : "⚡ Đã gửi yêu cầu tấn công";
    });
    const po = r?.po ?? r;
    if (po?.id) setPos((list) => upsertById(list, po));
  };
  const reset = async () => {
    const r = await act("reset", "/demo/reset", {}, () => "↺ Đã reset dữ liệu demo");
    if (r !== null) {
      setLogs([]);
      setCrs({});
      setInjected(false);
      setPos([]);
      loadAll();
    }
  };

  const recBySku = useMemo(
    () => Object.fromEntries(inv.recommendations.map((r) => [r.sku, r])),
    [inv.recommendations],
  );
  const nameBySku = useMemo(() => Object.fromEntries(inv.products.map((p) => [p.sku, p.name])), [inv.products]);
  const groups = useMemo(() => groupPosByStatus(pos), [pos]);
  const kpi = useMemo(() => computeKpis(pos), [pos]);

  return (
    <div className="dash">
      <section className="kpis">
        <Kpi label="Đơn tự động" value={kpi.executed} tone="ok" />
        <Kpi label="Bị chặn" value={kpi.blocked} tone="err" />
        <Kpi label="Chờ quorum" value={kpi.pending} tone="warn" />
        <div className="kpi wide">
          <div className="kpi-label">Tiền AI agent đã chi hôm nay</div>
          <div className="kpi-value">
            {formatVND(kpi.spent)} <span className="muted kpi-of">/ {formatVND(kpi.limit)}</span>
          </div>
          <div className="bar">
            <div className={`bar-fill ${kpi.pct >= 90 ? "hot" : ""}`} style={{ width: `${kpi.pct}%` }} />
          </div>
        </div>
      </section>

      <section className="controls">
        <button className="btn primary xl" disabled={!!busy} onClick={runAgents}>
          {busy === "run" ? "Đang chạy…" : "▶ Chạy AI agents"}
        </button>
        <button className={`btn xl ${injected ? "danger on" : "danger"}`} disabled={!!busy} onClick={toggleInject}>
          ☠ Đầu độc dữ liệu nhà cung cấp: {injected ? "BẬT" : "TẮT"}
        </button>
        <button className="btn xl warn" disabled={!!busy} onClick={attack}>
          ⚡ Agent bị chiếm quyền gọi thẳng API (80tr)
        </button>
        <button className="btn xl" disabled={!!busy} onClick={reset}>
          ↺ Reset demo
        </button>
        <span className={`pill ${conn === "open" ? "on" : ""}`}>Live: {conn === "open" ? "đã kết nối" : conn}</span>
      </section>
      {notice && <div className={`alert ${notice.tone}`}>{notice.text}</div>}

      <div className="split">
        <section className="card log-card">
          <h2>Nhật ký AI agent (trực tiếp)</h2>
          <AgentLog logs={logs} />
        </section>

        <section className="card inv-card">
          <h2>Tồn kho &amp; điểm đặt hàng</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th><th>Tên</th><th className="num">Tồn kho</th><th className="num">Đang về</th>
                  <th className="num">Nhu cầu/ngày</th><th className="num">Điểm đặt hàng</th>
                  <th className="num">Đề xuất</th><th>Trạng thái</th>
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
                  <tr><td colSpan={8} className="muted">Chưa có dữ liệu tồn kho.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section>
        <h2>Bảng đơn mua hàng (PO)</h2>
        <div className="board">
          {PO_COLUMNS.map((c) => (
            <div key={c.status} className={`col ${c.tone}`}>
              <div className="col-head">
                {c.label} <span className="count">{groups[c.status].length}</span>
              </div>
              {groups[c.status].map((po) => (
                <PoCard key={po.id} po={po} name={nameBySku[po.sku]} cr={crs[po.change_request_id]} />
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
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

function AgentLog({ logs }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);
  return (
    <div className="log" ref={ref}>
      {!logs.length && <div className="muted">Bấm “▶ Chạy AI agents” để xem các agent suy luận và hành động.</div>}
      {logs.map((l) => (
        <div key={l.key} className="log-line">
          <span className="log-time">{formatTime(l.ts)}</span>
          <span className={`agent-badge ${l.agent}`}>AI agent · {AGENT_LABEL[l.agent] ?? l.agent}</span>
          {l.step && <span className="log-step">{l.step}</span>}
          <span className="log-msg">{l.message}</span>
        </div>
      ))}
    </div>
  );
}

function PoCard({ po, name, cr }) {
  const approvals = cr?.approvals;
  const required = cr?.required;
  const rep = po.exception_report;
  return (
    <article className="po">
      <div className="po-head">
        <code>{po.sku}</code>
        <span className="po-total">{formatVND(po.total)}</span>
      </div>
      {name && <div className="small muted">{name}</div>}
      <dl className="po-kv">
        <dt>NCC</dt><dd>{po.supplier_id}</dd>
        <dt>SL</dt><dd>{formatNum(po.qty)} × {formatVND(po.unit_price)}</dd>
        <dt>Tạo bởi</dt><dd>{po.created_by}</dd>
      </dl>
      {po.justification && (
        <div className="untrusted">
          <div className="untrusted-label">Lý do của AI (không được tin)</div>
          <div>{po.justification}</div>
        </div>
      )}
      {po.checks?.length > 0 && (
        <ul className="checks">
          {po.checks.map((c, i) => (
            <li key={`${c.rule}-${i}`} className={c.ok ? "pass" : "fail"}>
              <span className="mark">{c.ok ? "✓" : "✗"}</span> <b>{c.rule}</b> <span className="detail">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {rep && (
        <div className="report">
          <div className="report-head">
            🔎 Báo cáo ngoại lệ · <b>{REC_LABEL[rep.recommendation] ?? rep.recommendation}</b>
          </div>
          <div>{rep.summary}</div>
          {rep.risk_flags?.length > 0 && (
            <div className="flags">{rep.risk_flags.map((f) => <span key={f} className="flag">{f}</span>)}</div>
          )}
        </div>
      )}
      {po.change_request_id && (
        <div className="cr">
          CR <code>{po.change_request_id}</code>
          {required != null && (
            <span className="cr-q"> · {approvals ?? 0}/{required} phê duyệt</span>
          )}
          {cr?.status && <span className="pill">{cr.status}</span>}
        </div>
      )}
    </article>
  );
}
