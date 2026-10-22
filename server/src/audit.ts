import { createHash } from 'node:crypto';
import type { AuditEntry } from '../../shared/types.ts';
import { getDb, now } from './db.ts';

const GENESIS = '0'.repeat(64);

interface Row {
  seq: number;
  actor: string;
  action: string;
  target: string | null;
  ts: number;
  prev_hash: string;
  hash: string;
}

function digest(prev: string, seq: number, actor: string, action: string, target: string | null, ts: number): string {
  return createHash('sha256').update(`${prev}${seq}${actor}${action}${target ?? ''}${ts}`).digest('hex');
}

/** Append a hash-chained audit row. `actor` is a label ("agent-planner", "buyer1"). */
export function append(actor: string, action: string, target: string | null): void {
  const db = getDb();
  db.transaction(() => {
    const last = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as Pick<Row, 'seq' | 'hash'> | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.hash ?? GENESIS;
    const ts = now();
    db.prepare('INSERT INTO audit_log (seq, actor, action, target, ts, prev_hash, hash) VALUES (?,?,?,?,?,?,?)').run(
      seq, actor, action, target, ts, prev, digest(prev, seq, actor, action, target, ts),
    );
  })();
}

/** Walk the chain; brokenAt = first seq whose prev_hash/hash does not match. */
export function verify(): { ok: boolean; brokenAt: number | null } {
  const rows = getDb().prepare('SELECT * FROM audit_log ORDER BY seq').all() as Row[];
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== digest(r.prev_hash, r.seq, r.actor, r.action, r.target, r.ts)) {
      return { ok: false, brokenAt: r.seq };
    }
    prev = r.hash;
  }
  return { ok: true, brokenAt: null };
}

/** Newest first. */
export function list(limit = 500): AuditEntry[] {
  return getDb()
    .prepare('SELECT seq, actor, action, target, ts, hash FROM audit_log ORDER BY seq DESC LIMIT ?')
    .all(limit) as AuditEntry[];
}
