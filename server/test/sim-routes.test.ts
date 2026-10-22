import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { DEFAULT_KEY_ID, ROLES } from '../../shared/types.ts';
import { initSimulator, registerSimRoutes, tick, tickMs } from '../src/simulator.ts';
import { renderMetrics, registerExtraMetrics } from '../src/metrics.ts';

let now = 1_700_000_000_000;
function app(roles?: string[]) {
  const a = new Hono<any>();
  if (roles) a.use('*', async (c, next) => { c.set('roles', roles); await next(); });
  registerSimRoutes(a);
  return a;
}
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  initSimulator(db, { now: () => now, timeScale: 1, random: () => 0.5 });
  process.env.SIMULATOR = 'on';
});
afterEach(() => { delete process.env.SIMULATOR; registerExtraMetrics(null); });

describe('sim routes', () => {
  it('GET /api/nodes returns NodesRes', async () => {
    const r = await app().request('/api/nodes');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.key_id).toBe(DEFAULT_KEY_ID);
    expect(j.nodes).toHaveLength(20);
    expect(j.health.margin).toBe(6);
  });

  it('GET /api/nodes 404 for unknown key', async () => {
    expect((await app().request('/api/nodes?key_id=nope')).status).toBe(404);
  });

  it('/api/chaos 403 when SIMULATOR is off', async () => {
    delete process.env.SIMULATOR;
    const r = await app().request('/api/chaos', post({ action: 'kill', node_ids: ['ork-01'] }));
    expect(r.status).toBe(403);
  });

  it('/api/chaos 403 without PLATFORM role, 200 with it', async () => {
    expect((await app([ROLES.MONITOR]).request('/api/chaos', post({ action: 'kill', node_ids: ['ork-01'] }))).status).toBe(403);
    const r = await app([ROLES.PLATFORM]).request('/api/chaos', post({ action: 'kill', node_ids: ['ork-01'] }));
    expect(r.status).toBe(200);
    expect((await r.json()).nodes).toHaveLength(20);
  });

  it('/api/chaos 400 on bad body', async () => {
    expect((await app().request('/api/chaos', post({ action: 'nuke', node_ids: ['ork-01'] }))).status).toBe(400);
    expect((await app().request('/api/chaos', post({ action: 'kill', node_ids: ['ork-99'] }))).status).toBe(400);
  });

  it('GET /api/nodes 403 for a role outside PLATFORM/MONITOR', async () => {
    expect((await app([ROLES.STAFF]).request('/api/nodes')).status).toBe(403);
  });
});

describe('metrics', () => {
  it('exposes the expected series names', async () => {
    await app().request('/api/chaos', post({ action: 'stale', node_ids: ['ork-01'] }));
    for (let i = 0; i < 3; i++) tick((now += tickMs()));
    registerExtraMetrics(() => ['# TYPE tidewatch_decrypt_total counter', 'tidewatch_decrypt_total{tag="kyc",ok="true"} 3']);
    const r = await app().request('/api/metrics');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    const t = await r.text();
    expect(t).toBe(renderMetrics());
    expect(t).toContain('tidewatch_node_state{key_id="kyc-key",node_id="ork-01",state="stale"} 1');
    expect(t).toContain('tidewatch_node_state{key_id="kyc-key",node_id="ork-01",state="healthy"} 0');
    expect(t).toContain('tidewatch_key_margin{key_id="kyc-key"} 5');
    expect(t).toContain('tidewatch_shard_loss_budget{key_id="kyc-key"} 5');
    expect(t).toMatch(/tide_ork_outbound_duration_seconds_bucket\{target="ork-01",endpoint="[^"]+",status="200",le="\+Inf"\} \d+/);
    expect(t).toContain('tide_ork_outbound_duration_seconds_sum{');
    expect(t).toContain('tide_ork_outbound_duration_seconds_count{');
    expect(t).toMatch(/tide_crypto_errors_total\{type="[^"]+",scheme="[^"]+",side="[^"]+"\} [1-9]/);
    expect(t).toContain('tidewatch_decrypt_total{tag="kyc",ok="true"} 3');
    expect(t.split('\n').filter((l) => l.startsWith('tidewatch_node_state{'))).toHaveLength(100);
  });
});
