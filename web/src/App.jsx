import React, { Suspense, useEffect, useState } from "react";
import { useTideCloak } from "@tidecloak/react";
import { getMe } from "./lib/api.js";
import { ROLES } from "./lib/roles.js";
import Customer from "./pages/Customer.jsx";
import Staff from "./pages/Staff.jsx";
import "./style.css";

const Monitor = React.lazy(() => import("./pages/Monitor.jsx"));
const Platform = React.lazy(() => import("./pages/Platform.jsx"));
const Approver = React.lazy(() => import("./pages/Approver.jsx"));

const TABS = [
  { role: ROLES.CUSTOMER, label: "Khách hàng", Comp: Customer },
  { role: ROLES.STAFF, label: "Thẩm định", Comp: Staff },
  { role: ROLES.MONITOR, label: "Giám sát", Comp: Monitor },
  { role: ROLES.PLATFORM, label: "Nền tảng", Comp: Platform },
  { role: ROLES.APPROVER, label: "Phê duyệt", Comp: Approver },
];

// Fallback when /api/me is unreachable: read roles straight from the token.
function rolesFromToken(tc) {
  return TABS.map((t) => t.role).filter((r) =>
    r === ROLES.APPROVER ? tc.hasClientRole?.(r, "realm-management") : tc.hasRealmRole?.(r),
  );
}

export default function App() {
  const tc = useTideCloak();
  const { authenticated, isInitializing, isLoading, initError, login, logout, getValueFromToken } = tc;
  const [me, setMe] = useState(null);
  const [meError, setMeError] = useState(null);
  const [tab, setTab] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!authenticated) { setMe(null); return; }
    let alive = true;
    (async () => {
      try {
        const token = (await tc.getToken?.()) || tc.token;
        const res = await getMe(token);
        if (alive) { setMe(res); setMeError(null); }
      } catch (err) {
        if (alive) {
          setMeError(err.message || String(err));
          setMe({ actor_hash: null, roles: rolesFromToken(tc) });
        }
      }
    })();
    return () => { alive = false; };
  }, [authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startLogin() {
    setNotice(null);
    try {
      await login();
    } catch (err) {
      setNotice(`Không bắt đầu đăng nhập được: ${err?.message || err}. Kiểm tra TideCloak ở localhost:8080.`);
    }
  }

  if (isInitializing) return <main className="center muted">Đang kết nối TideCloak…</main>;

  const userName = authenticated ? getValueFromToken("name") || getValueFromToken("preferred_username") : null;
  const tabs = me ? TABS.filter((t) => me.roles?.includes(t.role)) : [];
  const active = tabs.find((t) => t.role === tab) || tabs[0];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Tide Watch</div>
        <div className="row">
          <span className={`pill ${authenticated ? "on" : ""}`}>{authenticated ? `TideCloak · ${userName || "đã đăng nhập"}` : "Chưa đăng nhập"}</span>
          {authenticated && <button className="btn" onClick={logout}>Đăng xuất</button>}
        </div>
      </header>

      {initError && <div className="alert err">Khởi tạo TideCloak thất bại: {initError.message}</div>}
      {notice && <div className="alert err">{notice}</div>}

      {!authenticated ? (
        <main className="card login">
          <h1>Giám sát quyền truy cập dữ liệu KYC</h1>
          <p className="muted">Đăng nhập bằng TideCloak để tiếp tục.</p>
          <button className="btn primary" onClick={startLogin} disabled={isLoading}>
            {isLoading ? "Đang mở đăng nhập…" : "Đăng nhập với TideCloak"}
          </button>
        </main>
      ) : !me ? (
        <main className="center muted">Đang tải quyền…</main>
      ) : (
        <main>
          {meError && <div className="alert warn small">/api/me lỗi ({meError}) — đang dùng quyền đọc từ token.</div>}
          {tabs.length === 0 ? (
            <div className="card">Tài khoản chưa được gán vai trò nào trong Tide Watch.</div>
          ) : (
            <>
              <nav className="tabs">
                {tabs.map((t) => (
                  <button key={t.role} className={t === active ? "tab active" : "tab"} onClick={() => setTab(t.role)}>
                    {t.label}
                  </button>
                ))}
              </nav>
              <Suspense fallback={<div className="card muted">Đang tải…</div>}>
                <active.Comp me={me} />
              </Suspense>
            </>
          )}
        </main>
      )}
    </div>
  );
}
