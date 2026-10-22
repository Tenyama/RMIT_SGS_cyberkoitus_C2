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
    () => ({ getToken: async () => null, logout: null, isApprover: false, mode: "DEV" }),
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
      mode: "TIDE",
    }),
    [getToken, logout, hasClientRole, authenticated],
  );
  if (isInitializing) return <Splash text="Connecting to TideCloak…" />;
  if (initError) return <Splash text={`TideCloak error: ${initError.message}`} error />;
  if (!authenticated) return <Login onLogin={login} />;
  return <Shell auth={auth} />;
}

function Splash({ text, error }) {
  return (
    <div className="login-page">
      <div className={`login-card ${error ? "err" : ""}`}>
        <div className="brand-lg">ProcureGuard</div>
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
        <div className="brand-lg">ProcureGuard</div>
        <h1>AI agents buy for you — but can never grant themselves authority</h1>
        <p className="muted">
          Every purchase order an AI agent proposes goes through hard policy. Over the limit → it needs a quorum
          approval on Tide. Nobody, not even the AI, holds a master key.
        </p>
        <ul className="login-points">
          <li>3 AI agents — each with its own TideCloak identity</li>
          <li>Policy: 10,000,000 VND per order, 30,000,000 VND per day</li>
          <li>Exceptions unlock only with an approver quorum</li>
          <li>Hash-chained audit log</li>
        </ul>
        <button
          className="btn primary xl"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await onLogin(); } finally { setBusy(false); }
          }}
        >
          {busy ? "Redirecting…" : "Sign in with Tide"}
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
    if (roles.includes(ROLES.BUYER)) t.push({ id: "dash", label: "Dashboard" });
    if (roles.includes(ROLES.APPROVER) || auth.isApprover) t.push({ id: "approve", label: "Approvals" });
    if (roles.includes(ROLES.AUDITOR)) t.push({ id: "audit", label: "Audit" });
    return t;
  }, [me, auth.isApprover]);

  const active = tabs.find((t) => t.id === tab)?.id ?? tabs[0]?.id;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden="true">◆</span> ProcureGuard</div>
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={`tab ${active === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="row">
          {me && <span className="user">{me.actor}</span>}
          <span className={`mode-badge ${auth.mode === "DEV" ? "dev" : "tide"}`}>{auth.mode}</span>
          {auth.logout && (
            <button className="btn ghost" onClick={() => auth.logout()}>
              Sign out
            </button>
          )}
        </div>
      </header>

      {err && <div className="alert err">Could not load /api/me: {err}</div>}
      {!me && !err && <p className="center muted">Loading…</p>}
      {me && tabs.length === 0 && (
        <div className="alert warn">
          Account <b>{me.actor}</b> has no role yet (proc.buyer / proc.auditor / tide-realm-admin).
        </div>
      )}

      {active === "dash" && <Dashboard getToken={auth.getToken} />}
      {active === "audit" && <Audit getToken={auth.getToken} />}
      {active === "approve" && (
        <Boundary fallback="The approvals page needs a real Tide sign-in (not available in dev mode).">
          <Suspense fallback={<p className="center muted">Loading…</p>}>
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
