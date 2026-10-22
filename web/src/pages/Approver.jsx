// Approver page (track P3). Read-only view of pending IGA change requests + the PO each one unlocks.
// Approval happens ONLY in the TideCloak admin console with the approver's Tide enclave —
// ProcureGuard never authorizes, denies or commits a change request.
import { useCallback, useEffect, useState } from "react";
import { useTideCloak } from "@tidecloak/react";
import { STATUS_LINE, formatTime, formatVND, formatNum } from "../lib/format.js";

const POLL_MS = 5000;
const REC = { approve: "Recommend approve", reject: "Recommend reject", investigate: "Investigate" };

function consoleUrl(config) {
  const base = String(config?.["auth-server-url"] ?? "http://localhost:8080").replace(/\/$/, "");
  const realm = config?.realm ?? "test1";
  return `${base}/admin/master/console/#/${encodeURIComponent(realm)}`;
}

async function getJson(path, token) {
  const res = await fetch(path, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* non-JSON */ }
    throw new Error(res.status === 403 ? "403 — this account is not an approver (tide-realm-admin)" : msg);
  }
  return res.json();
}

function PoDetails({ po }) {
  const [open, setOpen] = useState(false);
  if (!po) return <div className="muted small">Linked purchase order not found yet.</div>;
  const checks = po.checks ?? [];
  const failed = checks.filter((c) => !c.ok);
  const rep = po.exception_report;
  return (
    <div>
      <div className="po-head">
        <code className="po-sku">{po.sku}</code>
        <span className="po-total">{formatVND(po.total)}</span>
      </div>
      <div className="po-meta">
        <span>{po.supplier_id}</span>
        <span className="muted">{formatNum(po.qty)} × {formatVND(po.unit_price)}</span>
      </div>
      <div className="po-status">{STATUS_LINE[po.status] ?? po.status}</div>
      {checks.length > 0 && failed.length === 0 && (
        <div className="checks-ok">{checks.length}/{checks.length} rules passed ✓</div>
      )}
      {failed.length > 0 && (
        <ul className="checks fail">
          {failed.map((c) => <li key={c.rule}><b>{c.rule}</b> <span>{c.detail}</span></li>)}
        </ul>
      )}
      {rep && (
        <div className="callout">
          <div className="callout-head">Exception report · <b>{REC[rep.recommendation] ?? rep.recommendation}</b></div>
          <div className="callout-body">{rep.summary}</div>
          {rep.risk_flags?.length > 0 && (
            <div className="flags">{rep.risk_flags.map((f) => <span key={f} className="flag">{f}</span>)}</div>
          )}
        </div>
      )}
      <button className="link-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Hide details" : "Details"}
      </button>
      {open && (
        <div className="po-details">
          <div className="small muted">PO {po.id} · created by {po.created_by}</div>
          {po.justification && (
            <div className="untrusted">
              <div className="untrusted-label">AI rationale (untrusted)</div>
              <div>{po.justification}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Approver() {
  const { authenticated, token, getToken, getConfig } = useTideCloak();
  const [items, setItems] = useState([]);
  const [pos, setPos] = useState([]);
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(async () => {
    try {
      const t = (await getToken()) ?? token;
      const [crs, poList] = await Promise.all([
        getJson("/api/change-requests", t),
        getJson("/api/po?status=pending_approval", t).catch(() => ({ items: [] })),
      ]);
      setItems(crs.items ?? []);
      setPos(poList.items ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message);
    }
  }, [getToken, token]);

  useEffect(() => {
    if (!authenticated) return undefined;
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [authenticated, load]);

  if (!authenticated) return <p className="center muted">Sign in with an approver account to see approval requests.</p>;

  let cfg = null;
  try { cfg = getConfig(); } catch { /* config not loaded yet */ }
  const url = consoleUrl(cfg);
  const poFor = (cr) => pos.find((p) => p.change_request_id === cr.id || (cr.po_id && p.id === cr.po_id));

  return (
    <section>
      <div className="row between audit-top">
        <h2>Approval requests (IGA)</h2>
        <a className="btn primary" href={url} target="_blank" rel="noopener noreferrer">Approve in TideCloak</a>
      </div>
      <p className="muted small">Open Change requests in the TideCloak console and sign with your Tide key. ProcureGuard never approves anything itself.</p>
      {loadError && <div className="alert err">Could not load: {loadError}</div>}
      {items.length === 0 && !loadError && <div className="empty">No pending requests.</div>}
      <div className="approver-grid">
        {items.map((cr) => (
          <article key={cr.id} className="po s-pending_approval">
            <div className="cta">
              <div className="cta-info">
                <span className="muted small">Change request</span> <code>{cr.id}</code>
                <span className="cta-q">{cr.approvals}/{cr.required} approvals</span>
              </div>
              <span className="muted small">{cr.status} · {formatTime(cr.updated_at)}</span>
            </div>
            {cr.summary && <div className="po-name">{cr.summary}</div>}
            <PoDetails po={poFor(cr)} />
          </article>
        ))}
      </div>
    </section>
  );
}
