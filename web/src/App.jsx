// Login + role routing (track P4). Tabs come from GET /api/me roles; the server re-checks every call.
import { Component, lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useTideCloak } from "@tidecloak/react";
import { DEV, getMe } from "./lib/api.js";
import { ROLES } from "./lib/roles.js";
import Dashboard from "./pages/Dashboard.jsx";
import Audit from "./pages/Audit.jsx";

const Approver = lazy(() => import("./pages/Approver.jsx"));

export default function App() {
  return DEV ? <DevApp /> : <TideApp />;
}

function DevApp() {
  const auth = useMemo(
    () => ({ getToken: async () => null, logout: null, isApprover: false, mode: `dev · ${DEV.sub}` }),
    [],
  );
  return <Shell auth={auth} />;
}

function TideApp() {
  const { isInitializing, initError, authenticated, login, logout, getToken, hasClientRole } = useTideCloak();
  const auth = useMemo(
    () => ({
      getToken,
      logout,
      isApprover: authenticated ? hasClientRole(ROLES.APPROVER, "realm-management") : false,
      mode: "Tide",
    }),
    [getToken, logout, hasClientRole, authenticated],
  );
  if (isInitializing) return <Splash text="Đang kết nối TideCloak…" />;
  if (initError) return <Splash text={`Lỗi TideCloak: ${initError.message}`} error />;
  if (!authenticated) return <Login onLogin={login} />;
  return <Shell auth={auth} />;
}

function Splash({ text, error }) {
  return (
    <div className="login-page">
      <div className={`login-card ${error ? "err" : ""}`}>
        <div className="brand-lg">🛡️ ProcureGuard</div>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Login({ onLogin }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand-lg">🛡️ ProcureGuard</div>
        <h1>AI agent tự động mua hàng — nhưng không bao giờ tự cấp quyền</h1>
        <p className="muted">
          Mọi đơn mua do AI agent đề xuất đều đi qua chính sách cứng. Vượt hạn mức → cần quorum phê duyệt trên
          Tide. Không ai, kể cả AI, nắm “chìa khóa vạn năng”.
        </p>
        <ul className="login-points">
          <li>🤖 3 AI agent — mỗi agent một danh tính TideCloak riêng</li>
          <li>📏 Chính sách: hạn mức 10.000.000 ₫/đơn, 30.000.000 ₫/ngày</li>
          <li>🔐 Ngoại lệ chỉ mở được bằng quorum người duyệt</li>
          <li>🧾 Nhật ký kiểm toán chuỗi hash</li>
        </ul>
        <button
          className="btn primary xl"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await onLogin(); } finally { setBusy(false); }
          }}
        >
          {busy ? "Đang chuyển hướng…" : "Đăng nhập với Tide"}
        </button>
      </div>
    </div>
  );
}

function Shell({ auth }) {
  const [me, setMe] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m = await getMe(await auth.getToken());
        if (alive) setMe(m);
      } catch (e) {
        if (alive) setErr(e.message);
      }
    })();
    return () => { alive = false; };
  }, [auth]);

  const tabs = useMemo(() => {
    if (!me) return [];
    const roles = me.roles || [];
    const t = [];
    if (roles.includes(ROLES.BUYER)) t.push({ id: "dash", label: "Bảng điều khiển" });
    if (roles.includes(ROLES.APPROVER) || auth.isApprover) t.push({ id: "approve", label: "Phê duyệt" });
    if (roles.includes(ROLES.AUDITOR)) t.push({ id: "audit", label: "Kiểm toán" });
    return t;
  }, [me, auth.isApprover]);

  const active = tabs.find((t) => t.id === tab)?.id ?? tabs[0]?.id;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🛡️ ProcureGuard</div>
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={`tab ${active === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="row">
          {me && <span className="pill">{me.actor}</span>}
          <span className="pill">{auth.mode}</span>
          {auth.logout && (
            <button className="btn" onClick={() => auth.logout()}>
              Đăng xuất
            </button>
          )}
        </div>
      </header>

      {err && <div className="alert err">Không tải được /api/me: {err}</div>}
      {!me && !err && <p className="center muted">Đang tải…</p>}
      {me && tabs.length === 0 && (
        <div className="alert warn">
          Tài khoản <b>{me.actor}</b> chưa có vai trò nào (proc.buyer / proc.auditor / tide-realm-admin).
        </div>
      )}

      {active === "dash" && <Dashboard getToken={auth.getToken} />}
      {active === "audit" && <Audit getToken={auth.getToken} />}
      {active === "approve" && (
        <Boundary fallback="Trang phê duyệt cần đăng nhập Tide thật (không chạy ở chế độ dev).">
          <Suspense fallback={<p className="center muted">Đang tải…</p>}>
            <Approver />
          </Suspense>
        </Boundary>
      )}
    </div>
  );
}

class Boundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="alert err">
          {this.props.fallback} <span className="small">({String(this.state.error.message || this.state.error)})</span>
        </div>
      );
    }
    return this.props.children;
  }
}
