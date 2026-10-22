import { randomUUID } from 'node:crypto';
import { ALERT_TRANSITIONS, type Alert, type AlertKind, type AlertSeverity, type AlertStatus } from '../../shared/types.ts';
import { getDb, now } from './db.ts';
import { append } from './audit.ts';
import { publish } from './sse.ts';

export class AlertTransitionError extends Error {
  status = 409 as const;
  constructor(public from: AlertStatus | null, public to: AlertStatus) {
    super(from ? `invalid transition ${from} -> ${to}` : 'alert not found');
    this.name = 'AlertTransitionError';
  }
}

export function getAlert(id: string): Alert | undefined {
  return getDb().prepare('SELECT * FROM alert WHERE id = ?').get(id) as Alert | undefined;
}

export function listAlerts(status?: string): Alert[] {
  const db = getDb();
  return (status
    ? db.prepare('SELECT * FROM alert WHERE status = ? ORDER BY opened_at DESC, id').all(status)
    : db.prepare('SELECT * FROM alert ORDER BY opened_at DESC, id').all()) as Alert[];
}

export function findActive(kind: AlertKind, subject: string): Alert | undefined {
  return getDb()
    .prepare("SELECT * FROM alert WHERE kind = ? AND subject = ? AND status IN ('open','proposed','pending_quorum')")
    .get(kind, subject) as Alert | undefined;
}

/** Idempotent: returns the existing active alert for (kind, subject) if any. */
export function openAlert(kind: AlertKind, severity: AlertSeverity, subject: string, detail: string | null): Alert {
  const existing = findActive(kind, subject);
  if (existing) return existing;
  const ts = now();
  const alert: Alert = { id: randomUUID(), kind, severity, subject, status: 'open', change_request_id: null, detail, opened_at: ts, updated_at: ts };
  try {
    getDb()
      .prepare(
        'INSERT INTO alert (id, kind, severity, subject, status, change_request_id, detail, opened_at, updated_at) VALUES (@id,@kind,@severity,@subject,@status,@change_request_id,@detail,@opened_at,@updated_at)',
      )
      .run(alert);
  } catch (e: any) {
    if (String(e?.code).startsWith('SQLITE_CONSTRAINT')) return findActive(kind, subject)!;
    throw e;
  }
  append('system', 'alert.open', `${alert.id}:${kind}`);
  publish({ type: 'alert.opened', alert });
  return alert;
}

/** Move an alert along ALERT_TRANSITIONS; throws AlertTransitionError (-> 409) otherwise. */
export function transition(id: string, to: AlertStatus, opts: { change_request_id?: string | null; actor_hash?: string } = {}): Alert {
  const cur = getAlert(id);
  if (!cur) throw new AlertTransitionError(null, to);
  if (!ALERT_TRANSITIONS[cur.status].includes(to)) throw new AlertTransitionError(cur.status, to);
  const next: Alert = {
    ...cur,
    status: to,
    change_request_id: opts.change_request_id !== undefined ? opts.change_request_id : cur.change_request_id,
    updated_at: now(),
  };
  const r = getDb()
    .prepare('UPDATE alert SET status = ?, change_request_id = ?, updated_at = ? WHERE id = ? AND status = ?')
    .run(next.status, next.change_request_id, next.updated_at, id, cur.status);
  if (r.changes !== 1) throw new AlertTransitionError(cur.status, to); // lost a race
  append(opts.actor_hash ?? 'system', `alert.${to}`, id);
  publish({ type: 'alert.updated', alert: next });
  return next;
}
