// Approver page (track A). Lists pending IGA change requests via our read-only proxy and
// authorizes/denies them directly against TideCloak with the approver's OWN token —
// the Tide Watch server never approves anything (docs/CONTRACTS.md, DESIGN §8.1).
import { useCallback, useEffect, useState } from "react";
import { useTideCloak } from "@tidecloak/react";

const POLL_MS = 5000;
const ERR_TEXT = {
  403: "403 — you are not an approver for this change",
  404: "404 — change request / entity vanished",
  409: "409 — already signed or no longer pending",
  412: "412 — quorum not met yet",
};

function igaBase(config) {
  const url = String(config?.["auth-server-url"] ?? "").replace(/\/$/, "");
  return `${url}/admin/realms/${encodeURIComponent(config?.realm ?? "")}/iga/change-requests`;
}

export default function Approver() {
  const { authenticated, getToken, getConfig } = useTideCloak();
  const [items, setItems] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null); // `${id}:${action}`
  const [results, setResults] = useState({}); // id -> { ok, text }

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch("/api/change-requests?status=PENDING", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(ERR_TEXT[res.status] ?? `HTTP ${res.status}`);
      const body = await res.json();
      setItems(body.items ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message);
    }
  }, [getToken]);

  useEffect(() => {
    if (!authenticated) return undefined;
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [authenticated, load]);

  async function act(id, action) {
    setBusy(`${id}:${action}`);
    try {
      const token = await getToken();
      const res = await fetch(`${igaBase(getConfig())}/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      const text = await res.text();
      let detail = "";
      try {
        const j = JSON.parse(text);
        detail = j.error ?? j.code ?? j.status ?? "";
      } catch {
        detail = text.slice(0, 120);
      }
      setResults((r) => ({
        ...r,
        [id]: res.ok
          ? { ok: true, text: `${action} ok${detail ? ` (${detail})` : ""}` }
          : { ok: false, text: `${ERR_TEXT[res.status] ?? `HTTP ${res.status}`}${detail ? `: ${detail}` : ""}` },
      }));
    } catch (e) {
      setResults((r) => ({ ...r, [id]: { ok: false, text: e.message } }));
    } finally {
      setBusy(null);
      load();
    }
  }

  if (!authenticated) return <p>Log in as an approver to review change requests.</p>;

  return (
    <section>
      <h2>Pending change requests</h2>
      {Object.entries(results)
        .filter(([id]) => !items.some((cr) => cr.id === id))
        .map(([id, r]) => (
          <p key={id} style={{ color: r.ok ? "green" : "crimson" }}>{id}: {r.text} (no longer pending)</p>
        ))}
      {loadError && <p style={{ color: "crimson" }}>Could not load: {loadError}</p>}
      {items.length === 0 && !loadError && <p>No pending change requests.</p>}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {items.map((cr) => (
            <tr key={cr.id} style={{ borderBottom: "1px solid #ddd" }}>
              <td style={{ padding: 8 }}>
                <div><strong>{cr.summary || cr.id}</strong></div>
                <small style={{ color: "#666" }}>
                  {cr.id} · {cr.status} · {new Date(cr.updated_at).toLocaleTimeString()}
                </small>
              </td>
              <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                <strong>{cr.approvals}/{cr.required}</strong> approvals
              </td>
              <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                <button disabled={busy !== null} onClick={() => act(cr.id, "authorize")}>
                  {busy === `${cr.id}:authorize` ? "Authorizing…" : "Authorize"}
                </button>{" "}
                <button disabled={busy !== null} onClick={() => act(cr.id, "deny")}>
                  {busy === `${cr.id}:deny` ? "Denying…" : "Deny"}
                </button>
                {results[cr.id] && (
                  <div style={{ color: results[cr.id].ok ? "green" : "crimson" }}>{results[cr.id].text}</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
