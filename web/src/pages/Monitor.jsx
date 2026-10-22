// Monitor view: open alerts (REST + alert.* events), propose-revoke / dismiss, quorum status, live decrypt rate.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTideCloak } from '@tidecloak/react';
import { openStream } from '../lib/stream.js';

const SEV = { crit: '#d63c3c', warn: '#e0a100', info: '#3a7bd5' };
const ACTIVE = ['open', 'proposed', 'pending_quorum'];

function authHeaders(token, extra = {}) {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

export default function Monitor() {
  const { token } = useTideCloak();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [alerts, setAlerts] = useState([]);
  const [crs, setCrs] = useState({}); // change_request_id -> {status, approvals, required}
  const [rates, setRates] = useState({}); // actor_hash -> count_10m
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const upsert = useCallback((a) => {
    setAlerts((list) => {
      const rest = list.filter((x) => x.id !== a.id);
      // keep terminal alerts visible so the operator sees resolved/denied/dismissed outcome
      return [a, ...rest].sort((x, y) => y.opened_at - x.opened_at);
    });
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/alerts?status=open', { headers: authHeaders(tokenRef.current) });
        if (!r.ok) throw new Error(`GET /api/alerts ${r.status}`);
        const j = await r.json();
        setAlerts((cur) => {
          const seen = new Set(cur.map((a) => a.id));
          return [...cur, ...j.items.filter((a) => !seen.has(a.id))].sort((x, y) => y.opened_at - x.opened_at);
        });
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
  }, []);

  useEffect(() => {
    return openStream(() => tokenRef.current, (ev) => {
      if (ev.type === 'alert.opened' || ev.type === 'alert.updated') upsert(ev.alert);
      else if (ev.type === 'cr.updated') setCrs((m) => ({ ...m, [ev.id]: { status: ev.status, approvals: ev.approvals, required: ev.required } }));
      else if (ev.type === 'decrypt.rate') setRates((m) => ({ ...m, [ev.actor_hash]: ev.count_10m }));
    });
  }, [upsert]);

  async function act(alert, path, body) {
    setBusy(alert.id);
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alert.id)}/${path}`, {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${path}: ${r.status} ${j.code || ''} ${j.error || ''}`);
      if (path === 'propose-revoke') upsert({ ...alert, status: 'pending_quorum', change_request_id: j.change_request_id, updated_at: Date.now() });
      else if (path === 'dismiss') upsert({ ...alert, status: 'dismissed', updated_at: Date.now() });
      setError(null);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(null);
    }
  }

  function dismiss(alert) {
    const reason = window.prompt('Lý do bỏ qua?');
    if (reason && reason.trim()) act(alert, 'dismiss', { reason: reason.trim() });
  }

  const rateRows = Object.entries(rates).sort((a, b) => b[1] - a[1]);

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', maxWidth: 960 }}>
      <h2 style={{ margin: '0 0 8px' }}>Cảnh báo</h2>
      {error && <div style={{ background: '#fde2e2', color: '#900', padding: 8, margin: '8px 0' }}>{error}</div>}
      {alerts.length === 0 && <div style={{ color: '#666' }}>Không có cảnh báo.</div>}

      {alerts.map((a) => {
        const cr = a.change_request_id ? crs[a.change_request_id] : null;
        const active = ACTIVE.includes(a.status);
        return (
          <div key={a.id} style={{ border: '1px solid #ddd', borderLeft: `6px solid ${SEV[a.severity] || '#999'}`, borderRadius: 6, padding: 12, margin: '8px 0', opacity: active ? 1 : 0.6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ background: SEV[a.severity] || '#999', color: '#fff', borderRadius: 4, padding: '2px 6px', fontSize: 12, fontWeight: 700 }}>{a.severity.toUpperCase()}</span>
              <strong>{a.kind}</strong>
              <code title="subject">{a.kind === 'decrypt_anomaly' ? a.subject.slice(0, 8) : a.subject}</code>
              <span style={{ background: '#eee', borderRadius: 10, padding: '2px 8px', fontSize: 12 }}>
                {a.status}
                {a.status === 'pending_quorum' && cr ? ` · ${cr.approvals}/${cr.required} approvals (${cr.status})` : ''}
              </span>
              <span style={{ fontSize: 12, color: '#888', marginLeft: 'auto' }}>{new Date(a.opened_at).toLocaleTimeString()}</span>
            </div>
            {a.detail && <div style={{ fontSize: 13, margin: '6px 0' }}>{a.detail}</div>}
            {a.status === 'open' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                {a.kind === 'decrypt_anomaly' && (
                  <button disabled={busy === a.id} onClick={() => act(a, 'propose-revoke')}>Đề xuất thu hồi</button>
                )}
                <button disabled={busy === a.id} onClick={() => dismiss(a)}>Bỏ qua</button>
              </div>
            )}
          </div>
        );
      })}

      <h3 style={{ marginTop: 24 }}>Tốc độ giải mã (10 phút)</h3>
      {rateRows.length === 0 ? (
        <div style={{ color: '#666' }}>Chưa có dữ liệu.</div>
      ) : (
        <table style={{ fontSize: 14 }}>
          <thead><tr><th align="left">actor</th><th align="right">records / 10'</th></tr></thead>
          <tbody>
            {rateRows.map(([actor, n]) => (
              <tr key={actor}><td><code>{actor.slice(0, 8)}</code></td><td align="right" style={{ color: n >= 50 ? '#d63c3c' : undefined, fontWeight: n >= 50 ? 700 : 400 }}>{n}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
