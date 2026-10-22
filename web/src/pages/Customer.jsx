import { useState } from "react";
import { useTideCloak } from "@tidecloak/react";
import { api } from "../lib/api.js";
import { encryptKyc, maskDisplay } from "../lib/tide.js";

const EMPTY = { full_name: "", id_number: "", phone: "", monthly_income: "" };

export default function Customer() {
  const tc = useTideCloak();
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const payload_ct = await encryptKyc(tc, { ...form, submitted_at: Date.now() });
      const display_mask = maskDisplay(form.full_name, form.phone);
      const token = (await tc.getToken?.()) || tc.token;
      const res = await api("/kyc", { method: "POST", token, body: { display_mask, payload_ct } });
      setResult({ id: res?.id, display_mask, payload_ct });
      setForm(EMPTY);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Nộp hồ sơ KYC</h2>
      <p className="muted">Dữ liệu được mã hoá ngay trên trình duyệt bằng Tide trước khi gửi đi. Máy chủ không thể đọc.</p>
      <form className="form" onSubmit={submit}>
        <label>Họ tên<input required value={form.full_name} onChange={set("full_name")} placeholder="Nguyễn Văn A" /></label>
        <label>Số CCCD<input required value={form.id_number} onChange={set("id_number")} inputMode="numeric" placeholder="079..." /></label>
        <label>Số điện thoại<input required value={form.phone} onChange={set("phone")} inputMode="tel" placeholder="09..." /></label>
        <label>Thu nhập tháng (VND)<input required value={form.monthly_income} onChange={set("monthly_income")} inputMode="numeric" placeholder="15000000" /></label>
        <button className="btn primary" disabled={busy}>{busy ? "Đang khoá…" : "Khoá & gửi"}</button>
      </form>
      {error && <div className="alert err">Lỗi: {error}</div>}
      {result && (
        <div className="alert ok">
          <strong>Đã khoá trên trình duyệt ✓</strong> Hồ sơ {result.id ? <code>{result.id}</code> : null} — hiển thị: {result.display_mask}
          <div className="muted small">Cơ sở dữ liệu chỉ lưu bản mã này:</div>
          <pre className="ct">{result.payload_ct.slice(0, 240)}{result.payload_ct.length > 240 ? "…" : ""}</pre>
        </div>
      )}
    </section>
  );
}
