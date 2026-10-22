import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  ROLES,
  RULES,
  type AlertKind,
  type AlertSeverity,
  type AlertsRes,
  type ChangeRequest,
  type DecryptBeaconReq,
  type DismissReq,
  type KycCreateReq,
  type KycItem,
  type KycListRes,
  type MeRes,
  type ProposeRevokeRes,
  type Role,
  type StreamEvent,
} from '../../shared/types.ts';
import { openDb, setDb, setClock, now, getDb, type Db } from './db.ts';
import { authMiddleware, requireRole, type AppEnv } from './auth.ts';
import { lookupSub } from './hmac.ts';
import { append } from './audit.ts';
import { AlertTransitionError, getAlert, listAlerts, openAlert, transition } from './alerts.ts';
import { onBeacon, scaled, startRules } from './rules.ts';
import { publish, streamHandler } from './sse.ts';

/** Track A seam (server/src/iga.ts). */
export interface IgaModule {
  revokeRole?: (sub: string, role: string) => Promise<{ change_request_id: string }>;
  listChangeRequests?: (status?: string) => Promise<ChangeRequest[]>;
  registerIgaRoutes?: (app: Hono<any>) => void;
}
/** Track D seam (server/src/simulator.ts). */
export interface SimModule {
  registerSimRoutes?: (app: Hono<any>) => void;
  initSimulator?: (db: Db, opts: { publish: (ev: StreamEvent) => void; openAlert: (a: { kind: AlertKind; severity: AlertSeverity; subject: string; detail: string }) => void }) => void;
  startSimulator?: () => () => void;
}
export interface AppDeps {
  db?: Db;
  clock?: () => number;
  iga?: IgaModule;
  sim?: SimModule;
}

const ALL_ROLES = new Set<string>(Object.values(ROLES));

function isIgaError(e: unknown): e is { code: string; status: number; message: string } {
  return !!e && typeof (e as any).code === 'string' && typeof (e as any).status === 'number';
}

export function createApp(deps: AppDeps = {}) {
  setDb(deps.db ?? openDb());
  if (deps.clock) setClock(deps.clock);
  const iga = deps.iga ?? {};
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof AlertTransitionError) return c.json({ error: err.message, code: 'CONFLICT' }, 409);
    console.error('[api]', err);
    return c.json({ error: 'internal error' }, 500);
  });

  // /api/metrics is scraped by Prometheus without auth (track D).
  app.use('/api/*', (c, next) => (c.req.path === '/api/metrics' ? next() : authMiddleware(c, next)));

  app.get('/api/me', (c) => {
    const res: MeRes = { actor_hash: c.get('actor_hash'), roles: c.get('roles').filter((r) => ALL_ROLES.has(r)) as Role[] };
    return c.json(res);
  });

  app.post('/api/kyc', requireRole(ROLES.CUSTOMER), async (c) => {
    const body = (await c.req.json().catch(() => null)) as KycCreateReq | null;
    if (!body || typeof body.display_mask !== 'string' || typeof body.payload_ct !== 'string' || !body.payload_ct) {
      return c.json({ error: 'display_mask and payload_ct required' }, 400);
    }
    const id = randomUUID();
    getDb()
      .prepare('INSERT INTO kyc_record (id, owner_hash, display_mask, payload_ct, created_at) VALUES (?,?,?,?,?)')
      .run(id, c.get('actor_hash'), body.display_mask, body.payload_ct, now());
    append(c.get('actor_hash'), 'kyc.create', id);
    return c.json({ id }, 201);
  });

  // Cursor = base64url("created_at:id") of the last item; newest first.
  app.get('/api/kyc', requireRole(ROLES.STAFF), (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
    const cursor = c.req.query('cursor');
    let rows: KycItem[];
    const cols = 'SELECT id, display_mask, payload_ct, created_at FROM kyc_record';
    if (cursor) {
      const [ts, id] = Buffer.from(cursor, 'base64url').toString().split(':');
      rows = getDb()
        .prepare(`${cols} WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(Number(ts), Number(ts), id ?? '', limit + 1) as KycItem[];
    } else {
      rows = getDb().prepare(`${cols} ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit + 1) as KycItem[];
    }
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const res: KycListRes = {
      items,
      next_cursor: rows.length > limit && last ? Buffer.from(`${last.created_at}:${last.id}`).toString('base64url') : null,
    };
    return c.json(res);
  });

  app.post('/api/telemetry/decrypt', async (c) => {
    const body = (await c.req.json().catch(() => null)) as DecryptBeaconReq | null;
    if (!body || typeof body.ok !== 'boolean') return c.json({ error: 'ok (boolean) required' }, 400);
    onBeacon(c.get('actor_hash'), body);
    return c.body(null, 202);
  });

  app.get('/api/stream', requireRole(ROLES.MONITOR, ROLES.PLATFORM, ROLES.APPROVER), (c) => streamHandler(c, scaled(RULES.HEARTBEAT_MS)));

  app.get('/api/alerts', requireRole(ROLES.MONITOR), (c) => {
    const res: AlertsRes = { items: listAlerts(c.req.query('status') || undefined) };
    return c.json(res);
  });

  app.post('/api/alerts/:id/propose-revoke', requireRole(ROLES.MONITOR), async (c) => {
    const id = c.req.param('id');
    const me = c.get('actor_hash');
    const alert = getAlert(id);
    if (!alert) return c.json({ error: 'alert not found' }, 404);
    if (alert.kind !== 'decrypt_anomaly' || alert.status !== 'open') {
      return c.json({ error: `cannot propose revoke for ${alert.kind}/${alert.status}`, code: 'CONFLICT' }, 409);
    }
    const sub = lookupSub(alert.subject);
    if (!sub) return c.json({ error: 'actor unknown to this server instance (restarted?)', code: 'ENTITY_VANISHED' }, 404);
    if (!iga.revokeRole) return c.json({ error: 'IGA not configured', code: 'UNEXPECTED' }, 503);
    transition(id, 'proposed', { actor_hash: me });
    append(me, 'alert.propose_revoke', id);
    try {
      const { change_request_id } = await iga.revokeRole(sub, ROLES.STAFF);
      transition(id, 'pending_quorum', { change_request_id, actor_hash: me });
      const res: ProposeRevokeRes = { change_request_id };
      return c.json(res, 202);
    } catch (e) {
      transition(id, 'open', { actor_hash: me });
      if (isIgaError(e)) {
        const status = e.status >= 400 && e.status < 600 ? e.status : 502;
        return c.json({ error: e.message, code: e.code }, status as 400);
      }
      console.error('[propose-revoke]', e);
      return c.json({ error: 'IGA call failed', code: 'UNEXPECTED' }, 502);
    }
  });

  app.post('/api/alerts/:id/dismiss', requireRole(ROLES.MONITOR), async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Partial<DismissReq>;
    if (!getAlert(id)) return c.json({ error: 'alert not found' }, 404);
    const alert = transition(id, 'dismissed', { actor_hash: c.get('actor_hash') });
    append(c.get('actor_hash'), 'alert.dismiss', `${id}:${String(body.reason ?? '').slice(0, 200)}`);
    return c.json(alert);
  });

  iga.registerIgaRoutes?.(app);
  if (process.env.SIMULATOR === 'on') deps.sim?.registerSimRoutes?.(app);
  return app;
}

/** Optional module: missing file → undefined, so track C runs without A/D merged. */
async function optional<T>(spec: string): Promise<T | undefined> {
  try {
    return (await import(spec)) as T;
  } catch (e: any) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw e;
  }
}

async function main() {
  const iga = await optional<IgaModule>('./iga.ts');
  const sim = process.env.SIMULATOR === 'on' ? await optional<SimModule>('./simulator.ts') : undefined;
  const app = createApp({ iga, sim });
  startRules({ iga });
  // The simulator publishes its own events inside tick(); don't re-publish here.
  sim?.initSimulator?.(getDb(), { publish, openAlert: (a) => openAlert(a.kind, a.severity, a.subject, a.detail) });
  sim?.startSimulator?.();
  const metrics = await optional<{ registerExtraMetrics?: (fn: () => string[]) => void }>('./metrics.ts');
  metrics?.registerExtraMetrics?.(() => {
    const rows = getDb().prepare('SELECT tag, ok, SUM(count) AS n FROM decrypt_event GROUP BY tag, ok').all() as { tag: string; ok: number; n: number }[];
    return ['# TYPE tidewatch_decrypt_total counter', ...rows.map((r) => `tidewatch_decrypt_total{tag="${r.tag}",ok="${r.ok ? 'true' : 'false'}"} ${r.n}`)];
  });
  const port = Number(process.env.PORT) || 4000;
  serve({ fetch: app.fetch, port }, () => console.log(`tidewatch server :${port} auth=${process.env.AUTH_MODE ?? 'jwt'} sim=${!!sim} iga=${!!iga}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
