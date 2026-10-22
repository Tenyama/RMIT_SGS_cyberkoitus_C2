// Platform view: 20 ORK tiles, margin/budget, real-Fabric latency (if exposed), chaos buttons.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTideCloak } from '@tidecloak/react';
import { openStream } from '../lib/stream.js';

const COLORS = { healthy: '#22a559', slow: '#e0a100', down: '#d63c3c', stale: '#8a4fd1', lost: '#111' };
const ACTIONS = ['kill', 'slow', 'stale', 'revive'];

function authHeaders(token, extra = {}) {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

// Average latency per op from tide_midgard_op_duration_seconds_{sum,count}; {} if the series is absent.
function parseMidgard(text) {
  const acc = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^tide_midgard_op_duration_seconds_(sum|count)\{([^}]*)\}\s+([0-9.eE+-]+)/);
    if (!m) continue;
    const op = (m[2].match(/op="([^"]*)"/) || [])[1] || '?';
    const a = (acc[op] ||= { sum: 0, count: 0 });
    a[m[1]] += Number(m[3]);
  }
  return Object.fromEntries(Object.entries(acc).filter(([, v]) => v.count > 0).map(([op, v]) => [op, { avg_ms: (v.sum / v.count) * 1000, count: v.count }]));
}

export default function Platform() {
  const { token } = useTideCloak();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState(null);
  const [midgard, setMidgard] = useState({});
  const [streamStatus, setStreamStatus] = useState('connecting');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/nodes', { headers: authHeaders(tokenRef.current) });
      if (!r.ok) throw new Error(`GET /api/nodes ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // p95 values only arrive via polling
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const r = await fetch('/api/metrics');
        if (r.ok && !stop) setMidgard(parseMidgard(await r.text()));
      } catch { /* metrics optional */ }
    }
    poll();
    const t = setInterval(poll, 10000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    return openStream(() => tokenRef.current, (ev) => {
      if (ev.type === 'node.state') {
        setData((d) => d && d.key_id === ev.key_id
          ? { ...d, nodes: d.nodes.map((n) => (n.node_id === ev.node_id ? { ...n, state: ev.to, since: ev.ts } : n)) }
          : d);
      } else if (ev.type === 'key.margin') {
        setData((d) => d && d.key_id === ev.key_id
          ? { ...d, health: { key_id: ev.key_id, margin: ev.margin, budget: ev.budget, dos: ev.dos } }
          : d);
      }
    }, setStreamStatus);
  }, []);

  function toggle(id) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function doChaos(action) {
    if (!selected.size) return;
    try {
      const r = await fetch('/api/chaos', {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action, node_ids: [...selected], key_id: data?.key_id }),
      });
      if (!r.ok) throw new Error(`chaos ${action}: ${r.status} ${(await r.json().catch(() => ({}))).error || ''}`);
      setData(await r.json());
      setSelected(new Set());
      setError(null);
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  const h = data?.health;
  const midgardOps = Object.entries(midgard);

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', maxWidth: 960 }}>
      <h2 style={{ margin: '0 0 8px' }}>ORK swarm — {data?.key_id ?? '…'}</h2>
      <div style={{ fontSize: 12, color: '#666' }}>stream: {streamStatus}</div>
      {error && <div style={{ background: '#fde2e2', color: '#900', padding: 8, margin: '8px 0' }}>{error}</div>}

      {h?.dos && (
        <div style={{ background: '#111', color: '#fff', padding: 12, margin: '8px 0', fontWeight: 700, fontSize: 20 }}>
          DoS — fewer than 14 nodes can sign; key {h.key_id} is unavailable
        </div>
      )}

      {h && (
        <div style={{ display: 'flex', gap: 32, margin: '12px 0' }}>
          <Stat label="Margin (healthy+slow − 14)" value={h.margin} color={h.margin < 0 ? '#111' : h.margin <= 1 ? '#d63c3c' : h.margin <= 3 ? '#e0a100' : '#22a559'} />
          <Stat label="Shard-loss budget (6 − lost − stale)" value={h.budget} color={h.budget <= 2 ? '#d63c3c' : '#22a559'} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8 }}>
        {data?.nodes.map((n) => (
          <button
            key={n.node_id}
            onClick={() => toggle(n.node_id)}
            title={`${n.state}${n.last_error ? ' · ' + n.last_error : ''}`}
            style={{
              background: COLORS[n.state] || '#999', color: '#fff', border: selected.has(n.node_id) ? '3px solid #08f' : '3px solid transparent',
              borderRadius: 6, padding: '10px 4px', cursor: 'pointer', textAlign: 'center',
            }}
          >
            <div style={{ fontWeight: 700 }}>{n.node_id}</div>
            <div style={{ fontSize: 12 }}>{n.state}</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>{n.p95_ms != null ? `p95 ${n.p95_ms}ms` : '—'}</div>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, margin: '12px 0', alignItems: 'center' }}>
        <span>{selected.size} selected:</span>
        {ACTIONS.map((a) => (
          <button key={a} disabled={!selected.size} onClick={() => doChaos(a)}>{a}</button>
        ))}
        <button onClick={() => setSelected(new Set(data?.nodes.map((n) => n.node_id) || []))}>select all</button>
        <button onClick={() => setSelected(new Set())}>clear</button>
      </div>

      <div style={{ display: 'flex', gap: 12, fontSize: 12, flexWrap: 'wrap' }}>
        {Object.entries(COLORS).map(([s, c]) => (
          <span key={s}><span style={{ display: 'inline-block', width: 10, height: 10, background: c, marginRight: 4 }} />{s}</span>
        ))}
      </div>

      {midgardOps.length > 0 && (
        <div style={{ marginTop: 16, border: '1px solid #ddd', borderRadius: 6, padding: 12 }}>
          <h3 style={{ margin: '0 0 8px' }}>Real Tide Fabric (TideCloak tide_midgard_op)</h3>
          <table style={{ fontSize: 13 }}>
            <thead><tr><th align="left">op</th><th align="right">avg latency</th><th align="right">ops</th></tr></thead>
            <tbody>
              {midgardOps.map(([op, v]) => (
                <tr key={op}><td>{op}</td><td align="right">{v.avg_ms.toFixed(0)} ms</td><td align="right">{v.count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 48, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 12, color: '#555' }}>{label}</div>
    </div>
  );
}
