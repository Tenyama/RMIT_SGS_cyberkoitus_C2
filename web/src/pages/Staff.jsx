import { useCallback, useEffect, useState } from "react";
import { useTideCloak } from "@tidecloak/react";
import { api } from "../lib/api.js";
import { decryptMany } from "../lib/tide.js";

const FIELDS = [
  ["full_name", "Họ tên"],
  ["id_number", "Số CCCD"],
  ["phone", "SĐT"],
  ["monthly_income", "Thu nhập tháng"],
];

export default function Staff() {
  const tc = useTideCloak();
  const [items, setItems] = useState([]);
  const [opened, setOpened] = useState({}); // id -> decrypted object
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null); // id | 'all' | null
  const [listError, setListError] = useState(null);
  const [blocked, setBlocked] = useState(null); // error detail when decrypt fails
  const [lastBatch, setLastBatch] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const token = (await tc.getToken?.()) || tc.token;
      const res = await api("/kyc?limit=50", { token });
      setItems(res?.items || []);
    } catch (err) {
      setListError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [tc]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(rows, key) {
    if (!rows.length) return;
    setBusy(key);
    setBlocked(null);
    const t0 = performance.now();
    try {
      const objs = await decryptMany(tc, rows.map((r) => r.payload_ct));
      setOpened((o) => {
        const next = { ...o };
        rows.forEach((r, i) => { next[r.id] = objs[i]; });
        return next;
      });
      setLastBatch({ count: rows.length, ms: Math.round(performance.now() - t0) });
    } catch (err) {
      setBlocked(err?.message || String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="row between">
        <h2>Hồ sơ KYC</h2>
        <div className="row">
          <button className="btn" onClick={load} disabled={loading}>{loading ? "Đang tải…" : "Tải lại"}</button>
          <button className="btn primary" onClick={() => open(items, "all")} disabled={!!busy || !items.length}>
            {busy === "all" ? "Đang mở…" : `Mở tất cả (${items.length})`}
          </button>
        </div>
      </div>
      {blocked && (
        <div className="alert blocked" role="alert">
          <strong>Bị chặn — quyền đã bị thu hồi</strong>
          <div className="small">{blocked}</div>
        </div>
      )}
      {listError && <div className="alert err">Không tải được danh sách: {listError}</div>}
      {lastBatch && !blocked && (
        <p className="muted small">Đã giải mã {lastBatch.count} hồ sơ trong {lastBatch.ms} ms (1 lần gọi Tide).</p>
      )}
      <table className="table">
        <thead><tr><th>Hồ sơ</th><th>Nội dung</th><th /></tr></thead>
        <tbody>
          {items.length === 0 && !loading && <tr><td colSpan={3} className="muted">Chưa có hồ sơ.</td></tr>}
          {items.map((r) => {
            const d = opened[r.id];
            return (
              <tr key={r.id}>
                <td>{r.display_mask}<div className="muted small">{new Date(r.created_at).toLocaleString("vi-VN")}</div></td>
                <td>
                  {d ? (
                    <dl className="kv">
                      {FIELDS.map(([k, label]) => (
                        <div key={k}><dt>{label}</dt><dd>{d[k] ?? "—"}</dd></div>
                      ))}
                    </dl>
                  ) : (
                    <span className="muted small">đã khoá</span>
                  )}
                </td>
                <td>
                  <button className="btn" onClick={() => open([r], r.id)} disabled={!!busy || !!d}>
                    {busy === r.id ? "Đang mở…" : d ? "Đã mở" : "Mở"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
