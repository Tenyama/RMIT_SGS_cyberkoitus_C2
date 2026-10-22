import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, setDb, setClock, getDb } from '../src/db.ts';
import { onBeacon, pollOnce, resetRuleState } from '../src/rules.ts';
import { openAlert, transition, listAlerts, getAlert, AlertTransitionError } from '../src/alerts.ts';
import { append, verify } from '../src/audit.ts';
import { subscribe } from '../src/sse.ts';
import type { StreamEvent } from '../../shared/types.ts';

let t = 1_000_000;
beforeEach(() => {
  setDb(openDb(':memory:'));
  t = 1_000_000;
  setClock(() => t);
  resetRuleState();
});

const beacon = (count = 1, ok = true) => ({ tag: 'kyc', ok, latency_ms: 10, count });

describe('decrypt_anomaly rule', () => {
  it('49 records do not alert, the 50th does', () => {
    for (let i = 0; i < 49; i++) onBeacon('actorA', beacon());
    expect(listAlerts().filter((a) => a.kind === 'decrypt_anomaly')).toHaveLength(0);
    onBeacon('actorA', beacon());
    const a = listAlerts();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'decrypt_anomaly', severity: 'crit', subject: 'actorA', status: 'open' });
  });

  it('one beacon with count=50 triggers', () => {
    onBeacon('actorB', beacon(50));
    expect(listAlerts()).toHaveLength(1);
  });

  it('is idempotent while active and ignores other actors / old events / failures', () => {
    onBeacon('old', beacon(30));
    t += 11 * 60_000; // outside the 10' window
    onBeacon('old', beacon(30));
    onBeacon('fail', beacon(60, false));
    onBeacon('x', beacon(50));
    onBeacon('x', beacon(5));
    const a = listAlerts();
    expect(a.map((x) => x.subject)).toEqual(['x']);
  });

  it('publishes decrypt.rate and alert.opened', () => {
    const evs: StreamEvent[] = [];
    const off = subscribe((e) => evs.push(e));
    onBeacon('y', beacon(50));
    off();
    expect(evs.map((e) => e.type)).toEqual(expect.arrayContaining(['decrypt.rate', 'alert.opened']));
    expect(evs.find((e) => e.type === 'decrypt.rate')).toMatchObject({ actor_hash: 'y', count_10m: 50 });
  });
});

describe('alert transitions', () => {
  it('allows valid and rejects invalid transitions', () => {
    const a = openAlert('key_margin', 'warn', 'kyc-key', 'margin 3');
    expect(openAlert('key_margin', 'crit', 'kyc-key', 'dup').id).toBe(a.id); // idempotent
    expect(() => transition(a.id, 'pending_quorum')).toThrow(AlertTransitionError);
    expect(transition(a.id, 'proposed').status).toBe('proposed');
    expect(transition(a.id, 'open').status).toBe('open');
    expect(transition(a.id, 'dismissed').status).toBe('dismissed');
    expect(() => transition(a.id, 'open')).toThrow(AlertTransitionError);
    // terminal → a new active alert can be opened again
    expect(openAlert('key_margin', 'warn', 'kyc-key', null).id).not.toBe(a.id);
  });
});

describe('audit chain', () => {
  it('verifies, then detects one tampered row', () => {
    append('h1', 'kyc.create', 'k1');
    append('h2', 'alert.dismiss', 'a1');
    append('h3', 'alert.propose', 'a2');
    expect(verify()).toEqual({ ok: true, brokenAt: null });
    getDb().prepare("UPDATE audit_log SET target='evil' WHERE seq = (SELECT MIN(seq)+1 FROM audit_log)").run();
    const r = verify();
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBeTypeOf('number');
  });
});

describe('background poll', () => {
  it('tidecloak_down after 3 failures; CR committed resolves pending_quorum alert; quorum_stale', async () => {
    let up = false;
    const fetchFn = async () => ({ ok: up }) as Response;
    const crs = [{ id: 'cr1', status: 'PENDING', summary: 's', approvals: 0, required: 2, updated_at: t }];
    const iga = { listChangeRequests: async () => crs };
    const a = openAlert('decrypt_anomaly', 'crit', 'actorZ', null);
    transition(a.id, 'proposed');
    transition(a.id, 'pending_quorum', { change_request_id: 'cr1' });

    await pollOnce({ fetchFn, iga });
    await pollOnce({ fetchFn, iga });
    expect(listAlerts().some((x) => x.kind === 'tidecloak_down')).toBe(false);
    await pollOnce({ fetchFn, iga });
    expect(listAlerts().some((x) => x.kind === 'tidecloak_down' && x.status === 'open')).toBe(true);
    up = true;
    await pollOnce({ fetchFn, iga });
    expect(listAlerts().find((x) => x.kind === 'tidecloak_down')!.status).toBe('resolved');

    t += 16 * 60_000;
    await pollOnce({ fetchFn, iga });
    expect(listAlerts().some((x) => x.kind === 'quorum_stale' && x.status === 'open')).toBe(true);

    crs[0].status = 'COMMITTED';
    await pollOnce({ fetchFn, iga });
    expect(getAlert(a.id)!.status).toBe('resolved');
    expect(listAlerts().find((x) => x.kind === 'quorum_stale')!.status).toBe('resolved');
  });
});
