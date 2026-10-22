import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { ALERT_TRANSITIONS, MAX_FAULTY, SWARM_SIZE, THRESHOLD } from '../../shared/types.ts';

describe('contracts', () => {
  it('schema.sql applies cleanly and is idempotent', () => {
    const db = new Database(':memory:');
    const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    db.exec(sql);
    db.exec(sql);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['kyc_record', 'decrypt_event', 'node_state', 'node_event', 'alert', 'change_request_mirror', 'audit_log']));
  });

  it('swarm constants match Tide docs', () => {
    expect([SWARM_SIZE, THRESHOLD, MAX_FAULTY]).toEqual([20, 14, 6]);
  });

  it('terminal alert states have no exits', () => {
    for (const s of ['resolved', 'denied', 'dismissed'] as const) expect(ALERT_TRANSITIONS[s]).toEqual([]);
  });
});
