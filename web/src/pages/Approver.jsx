// Approver page (track P3). Read-only view of pending IGA change requests + the PO each one unlocks.
// Approval happens ONLY in the TideCloak admin console with the approver's Tide enclave —
// ProcureGuard never authorizes, denies or commits a change request.
import { useCallback, useEffect, useState } from "react";
import { useTideCloak } from "@tidecloak/react";

const POLL_MS = 5000;
const vnd = (n) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(n ?? 0);
const REC = { approve: "Đề xuất duyệt", reject: "Đề xuất từ chối", investigate: "Cần điều tra" };

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
    throw new Error(res.status === 403 ? "403 — tài khoản không có quyền approver (tide-realm-admin)" : msg);
  }
  return res.json();
}

function PoDetails({ po }) {
  if (!po) return <small style={{ color: "#666" }}>Chưa tìm thấy đơn hàng liên kết.</small>;
  const failed = (po.checks ?? []).filter((c) => !c.ok);
  const rep = po.exception_report;
  return (
    <div>
      <div>
        <strong>{po.sku}</strong> · NCC <strong>{po.supplier_id}</strong> · SL <strong>{po.qty}</strong> × {vnd(po.unit_price)} ={" "}
        <strong>{vnd(po.total)}</strong>
      </div>
      <small style={{ color: "#666" }}>Đơn {po.id} · tạo bởi {po.created_by}</small>
      {failed.length > 0 && (
        <ul style={{ margin: "4px 0", color: "crimson" }}>
          {failed.map((c) => <li key={c.rule}>{c.rule}: {c.detail}</li>)}
        </ul>
      )}
      {po.justification && <div><em>Lý do (do AI viết, không tin cậy):</em> {po.justification}</div>}
      {rep && (
        <div style={{ marginTop: 4 }}>
          <strong>Báo cáo ngoại lệ:</strong> {rep.summary} — <strong>{REC[rep.recommendation] ?? rep.recommendation}</strong>
          {rep.risk_flags?.length > 0 && <div><small>Cờ rủi ro: {rep.risk_flags.join(", ")}</small></div>}
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

  if (!authenticated) return <p>Đăng nhập bằng tài khoản approver để xem yêu cầu phê duyệt.</p>;

  let cfg = null;
  try { cfg = getConfig(); } catch { /* config not loaded yet */ }
  const url = consoleUrl(cfg);
  const poFor = (cr) => pos.find((p) => p.change_request_id === cr.id || (cr.po_id && p.id === cr.po_id));

  return (
    <section>
      <h2>Yêu cầu phê duyệt (IGA)</h2>
      <p>
        <a href={url} target="_blank" rel="noopener noreferrer">
          <button>Duyệt trong TideCloak</button>
        </a>{" "}
        <small>Mục Change requests → duyệt bằng Tide</small>
      </p>
      {loadError && <p style={{ color: "crimson" }}>Không tải được: {loadError}</p>}
      {items.length === 0 && !loadError && <p>Không có yêu cầu nào đang chờ.</p>}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {items.map((cr) => (
            <tr key={cr.id} style={{ borderBottom: "1px solid #ddd", verticalAlign: "top" }}>
              <td style={{ padding: 8 }}>
                <div><strong>{cr.summary || cr.id}</strong></div>
                <small style={{ color: "#666" }}>
                  {cr.id} · {cr.status} · {new Date(cr.updated_at).toLocaleTimeString("vi-VN")}
                </small>
              </td>
              <td style={{ padding: 8 }}><PoDetails po={poFor(cr)} /></td>
              <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                <strong>{cr.approvals}/{cr.required}</strong> chữ ký
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
