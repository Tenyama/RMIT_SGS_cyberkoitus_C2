// Auditor view (track P4): hash-chained audit log from GET /api/audit.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { formatDateTime } from "../lib/format.js";

export default function Audit({ getToken }) {
  const tokRef = useRef(getToken);
  tokRef.current = getToken;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api("/audit", { token: await tokRef.current() }));
      setErr(null);
    } catch (e) {
      setErr(e.status ? `${e.status} — ${e.message}` : e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const items = data?.items ?? [];
  return (
    <div>
      <div className="row between audit-top">
        <h2>Audit log</h2>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? <><span className="spinner" aria-hidden="true" /> Loading…</> : "Reload"}
        </button>
      </div>
      {err && <div className="alert err">Could not load /api/audit: {err}</div>}
      {data && (
        <div className={`banner ${data.valid ? "ok" : "bad"}`}>
          {data.valid ? "Hash chain valid ✓" : "Tampered ✗ — hash chain does not match"}
          <span className="banner-sub">{items.length} entries</span>
        </div>
      )}
      <div className="panel table-wrap">
        <table className="table compact">
          <thead>
            <tr><th className="num">#</th><th>Actor</th><th>Action</th><th>Target</th><th>Time</th><th>Hash</th></tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.seq}>
                <td className="num">{e.seq}</td>
                <td>{e.actor}</td>
                <td><b>{e.action}</b></td>
                <td>{e.target ? <code>{e.target}</code> : <span className="muted">—</span>}</td>
                <td>{formatDateTime(e.ts)}</td>
                <td><code className="hash" title={e.hash}>{String(e.hash || "").slice(0, 12)}…</code></td>
              </tr>
            ))}
            {data && !items.length && <tr><td colSpan={6} className="muted">No entries yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
