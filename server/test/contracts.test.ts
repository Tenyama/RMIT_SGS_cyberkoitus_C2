import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { PERMISSIONS, POLICY, ROLES } from '../../shared/types.ts';

describe('contracts', () => {
  it('schema.sql applies cleanly and is idempotent', () => {
    const db = new Database(':memory:');
    const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    db.exec(sql);
    db.exec(sql);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['product', 'supplier', 'supplier_offer', 'purchase_order', 'agent_run', 'audit_log']));
  });

  it('only the planner can submit, and no role grants approval inside the app', () => {
    const submitters = Object.entries(PERMISSIONS).filter(([, p]) => p.includes('po:submit')).map(([r]) => r);
    expect(submitters).toEqual([ROLES.AGENT_PLANNER]);
    expect(PERMISSIONS[ROLES.APPROVER]).toBeUndefined();
  });

  it('agent limit is below the daily limit', () => {
    expect(POLICY.AGENT_PO_LIMIT).toBeLessThan(POLICY.AGENT_DAILY_LIMIT);
  });
});
