import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { DEFAULT_KEY_ID, RULES, type StreamEvent } from '../../shared/types.ts';
import { initSimulator, getNodes, chaos, tick, tickMs } from '../src/simulator.ts';

const T0 = 1_700_000_000_000;
let now = T0;
let published: StreamEvent[] = [];
let alerts: any[] = [];

function freshDb() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return db;
}

function ticks(n: number) {
  const out: StreamEvent[] = [];
  for (let i = 0; i < n; i++) {
    now += tickMs();
    out.push(...tick(now));
  }
  return out;
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `ork-${String(i + 1).padStart(2, '0')}`);
const node = (id: string) => getNodes(DEFAULT_KEY_ID).nodes.find((n) => n.node_id === id)!;

let db: Database.Database;
beforeEach(() => {
  now = T0;
  published = [];
  alerts = [];
  db = freshDb();
  initSimulator(db, {
    publish: (e) => published.push(e),
    openAlert: (a) => alerts.push(a),
    now: () => now,
    timeScale: 1,
    random: () => 0.5,
  });
});

describe('simulator state machine', () => {
  it('seeds 20 healthy nodes with margin 6 / budget 6', () => {
    const r = getNodes(DEFAULT_KEY_ID);
    expect(r.nodes).toHaveLength(20);
    expect(r.nodes.every((n) => n.state === 'healthy')).toBe(true);
    expect(r.health).toEqual({ key_id: DEFAULT_KEY_ID, margin: 6, budget: 6, dos: false });
    expect(db.prepare('SELECT count(*) c FROM node_state').get()).toEqual({ c: 20 });
  });

  it('kill 5 -> margin 1 (after CONSECUTIVE_SAMPLES), opens key_margin crit', () => {
    chaos({ action: 'kill', node_ids: ids(5) });
    ticks(RULES.CONSECUTIVE_SAMPLES - 1);
    expect(getNodes(DEFAULT_KEY_ID).health.margin).toBe(6); // NFR6: not yet
    const evs = ticks(1);
    const h = getNodes(DEFAULT_KEY_ID).health;
    expect(h.margin).toBe(1);
    expect(h.dos).toBe(false);
    expect(evs.filter((e) => e.type === 'node.state')).toHaveLength(5);
    expect(evs.some((e) => e.type === 'key.margin' && e.margin === 1)).toBe(true);
    expect(published).toEqual(expect.arrayContaining(evs));
    expect(alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'key_margin', severity: 'crit', subject: DEFAULT_KEY_ID })]));
    expect(db.prepare("SELECT count(*) c FROM node_event WHERE to_state='down'").get()).toEqual({ c: 5 });
  });

  it('kill 7 -> dos true', () => {
    chaos({ action: 'kill', node_ids: ids(7) });
    ticks(RULES.CONSECUTIVE_SAMPLES);
    const h = getNodes(DEFAULT_KEY_ID).health;
    expect(h.margin).toBe(-1);
    expect(h.dos).toBe(true);
  });

  it('stale after 3 verify_failed samples, not after 2', () => {
    chaos({ action: 'stale', node_ids: ['ork-03'] });
    ticks(2);
    expect(node('ork-03').state).toBe('healthy');
    ticks(1);
    expect(node('ork-03').state).toBe('stale');
    expect(node('ork-03').last_error).toBe('TIDE-ORK-SIG-VERIFY_FAILED');
    expect(getNodes(DEFAULT_KEY_ID).health.budget).toBe(5);
  });

  it('stale recovers only after STALE_RECOVER_OK ok samples', () => {
    chaos({ action: 'stale', node_ids: ['ork-03'] });
    ticks(3);
    chaos({ action: 'revive', node_ids: ['ork-03'] });
    ticks(RULES.STALE_RECOVER_OK - 1);
    expect(node('ork-03').state).toBe('stale');
    ticks(1);
    expect(node('ork-03').state).toBe('healthy');
  });

  it('down -> lost after DOWN_TO_LOST_MS x TIME_SCALE', () => {
    chaos({ action: 'kill', node_ids: ['ork-01'] });
    ticks(3);
    expect(node('ork-01').state).toBe('down');
    const downAt = node('ork-01').since;
    now = downAt + RULES.DOWN_TO_LOST_MS - 1;
    tick(now);
    expect(node('ork-01').state).toBe('down');
    now = downAt + RULES.DOWN_TO_LOST_MS + 1;
    tick(now);
    expect(node('ork-01').state).toBe('lost');
    expect(getNodes(DEFAULT_KEY_ID).health.budget).toBe(5);
  });

  it('TIME_SCALE shrinks the down->lost window', () => {
    initSimulator(freshDb(), { now: () => now, timeScale: 0.01, random: () => 0.5 });
    chaos({ action: 'kill', node_ids: ['ork-01'] });
    ticks(3);
    now = node('ork-01').since + RULES.DOWN_TO_LOST_MS * 0.01 + 1;
    tick(now);
    expect(node('ork-01').state).toBe('lost');
  });

  it('revive returns a down node to healthy after 3 ok', () => {
    chaos({ action: 'kill', node_ids: ['ork-02'] });
    ticks(3);
    expect(node('ork-02').state).toBe('down');
    chaos({ action: 'revive', node_ids: ['ork-02'] });
    ticks(2);
    expect(node('ork-02').state).toBe('down');
    ticks(1);
    expect(node('ork-02').state).toBe('healthy');
    expect(node('ork-02').last_error).toBeNull();
  });

  it('slow after 3 samples with p95 > SLOW_P95_MS, back after 3 fast', () => {
    chaos({ action: 'slow', node_ids: ['ork-04'] });
    ticks(3);
    expect(node('ork-04').state).toBe('slow');
    expect(node('ork-04').p95_ms!).toBeGreaterThan(RULES.SLOW_P95_MS);
    expect(getNodes(DEFAULT_KEY_ID).health.margin).toBe(6); // slow still counts
    chaos({ action: 'revive', node_ids: ['ork-04'] });
    ticks(3);
    expect(node('ork-04').state).toBe('healthy');
  });

  it('shard_loss crit when budget <= BUDGET_CRIT', () => {
    chaos({ action: 'stale', node_ids: ids(4) });
    ticks(3);
    expect(getNodes(DEFAULT_KEY_ID).health.budget).toBe(2);
    expect(alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'shard_loss', severity: 'crit' })]));
  });

  it('state survives re-init from the same db', () => {
    chaos({ action: 'kill', node_ids: ['ork-01'] });
    ticks(3);
    initSimulator(db, { now: () => now });
    expect(node('ork-01').state).toBe('down');
  });
});
