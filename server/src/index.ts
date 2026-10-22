import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  ROLES,
  type AgentName, type DemoPresetName, type ExceptionReport, type InventoryPatchReq, type PolicyCheck,
  type PoStatus, type Product, type PurchaseOrder,
  type Recommendation, type StreamEvent, type Supplier, type SupplierOffer,
} from '../../shared/types.ts';
import { getDb, now, openDb, setDb, type Db } from './db.ts';
import { authMiddleware, requirePermission, type AppEnv } from './auth.ts';
import { evaluateSubmit } from './policy.ts';
import { bestLeadTime, recommend } from './replenish.ts';
import { applyPreset, injectMaliciousNote, resetDemo, seed } from './seed.ts';
import * as audit from './audit.ts';
import { publish, streamHandler } from './sse.ts';

// ---------- optional modules from other tracks (variable specifiers so tsc doesn't require them) ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = any;
async function optionalImport(spec: string): Promise<Mod | null> {
  try {
    return await import(/* @vite-ignore */ spec);
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module|Failed to load|does not exist/.test(String(e))) return null;
    throw e;
  }
}
const IGA_SPEC = './iga.ts';
const AGENTS_SPEC = './agents/index.ts';
const GOV_SPEC = './governance.ts';

export interface Deps {
  db?: Db;
  loadIga?: () => Promise<Mod | null>;
  loadAgents?: () => Promise<Mod | null>;
}

let deps: Required<Pick<Deps, 'loadIga' | 'loadAgents'>> = {
  loadIga: () => optionalImport(IGA_SPEC),
  loadAgents: () => optionalImport(AGENTS_SPEC),
};

// ---------- data access ----------
interface PoRow extends Omit<PurchaseOrder, 'checks' | 'exception_report'> {
  checks_json: string;
  exception_json: string | null;
  exception_used: number;
}
const toPo = (r: PoRow): PurchaseOrder => ({
  id: r.id, sku: r.sku, supplier_id: r.supplier_id, qty: r.qty, unit_price: r.unit_price, total: r.total,
  status: r.status, created_by: r.created_by, justification: r.justification,
  checks: JSON.parse(r.checks_json) as PolicyCheck[],
  change_request_id: r.change_request_id,
  exception_report: r.exception_json ? (JSON.parse(r.exception_json) as ExceptionReport) : null,
  created_at: r.created_at, updated_at: r.updated_at,
});
const poRow = (id: string) => getDb().prepare('SELECT * FROM purchase_order WHERE id = ?').get(id) as PoRow | undefined;
const getPo = (id: string) => {
  const r = poRow(id);
  return r ? toPo(r) : null;
};
const products = () => getDb().prepare('SELECT * FROM product ORDER BY sku').all() as Product[];
const product = (sku: string) => getDb().prepare('SELECT * FROM product WHERE sku = ?').get(sku) as Product | undefined;
const suppliers = () =>
  (getDb().prepare('SELECT * FROM supplier ORDER BY id').all() as (Omit<Supplier, 'approved'> & { approved: number })[]).map((s) => ({ ...s, approved: !!s.approved }));
const offers = (sku?: string) =>
  (sku
    ? getDb().prepare('SELECT * FROM supplier_offer WHERE sku = ? ORDER BY unit_price').all(sku)
    : getDb().prepare('SELECT * FROM supplier_offer ORDER BY sku, unit_price').all()) as SupplierOffer[];

export function recommendationFor(p: Product, sup = suppliers(), offs = offers()): Recommendation {
  return recommend(p, bestLeadTime(p.sku, offs, sup));
}

/** Sum of totals of POs executed today (local day) by agents. */
export function dailySpent(at: number = now()): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  const r = getDb()
    .prepare("SELECT COALESCE(SUM(total),0) AS s FROM purchase_order WHERE status='executed' AND created_by LIKE 'agent-%' AND updated_at >= ?")
    .get(d.getTime()) as { s: number };
  return r.s;
}

function setStatus(id: string, status: PoStatus): PurchaseOrder | null {
  getDb().prepare('UPDATE purchase_order SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  const po = getPo(id);
  if (po) publish({ type: 'po.updated', po });
  return po;
}

/** Governance: IGA CR approved → PO waits for the planner's re-submit. */
export function markApproved(poId: string): PurchaseOrder | null {
  const r = poRow(poId);
  if (!r || r.status !== 'pending_approval') return r ? toPo(r) : null;
  audit.append('governance', 'po.approved', poId);
  return setStatus(poId, 'approved');
}
/** Governance: IGA CR denied. */
export function markRejected(poId: string): PurchaseOrder | null {
  const r = poRow(poId);
  if (!r || (r.status !== 'pending_approval' && r.status !== 'approved')) return r ? toPo(r) : null;
  audit.append('governance', 'po.rejected', poId);
  return setStatus(poId, 'rejected');
}

const publishInventory = () => publish({ type: 'inventory.updated', products: products() });
const newId = (p: string) => `${p}-${randomBytes(4).toString('hex')}`;

// ---------- app ----------
export function createApp(d: Deps = {}) {
  if (d.db) setDb(d.db);
  if (d.loadIga) deps.loadIga = d.loadIga;
  if (d.loadAgents) deps.loadAgents = d.loadAgents;
  seed(getDb());

  const app = new Hono<AppEnv>();
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.use('/api/*', async (c, next) => (c.req.path === '/api/health' ? next() : authMiddleware(c, next)));

  app.get('/api/me', (c) => c.json({ actor: c.get('actor'), roles: c.get('roles'), permissions: c.get('permissions') }));

  app.get('/api/inventory', requirePermission('inventory:read'), (c) => {
    const ps = products();
    const sup = suppliers();
    const offs = offers();
    return c.json({ products: ps, recommendations: ps.map((p) => recommendationFor(p, sup, offs)) });
  });

  // Edit the inputs of the reorder math (on_hand / demand / safety stock). The policy engine is untouched.
  app.patch('/api/inventory/:sku', requirePermission('inventory:edit'), async (c) => {
    const sku = c.req.param('sku');
    const p = product(sku);
    if (!p) return c.json({ error: `unknown sku ${sku}`, code: 'NOT_FOUND' }, 404);
    const b = (await c.req.json().catch(() => null)) as InventoryPatchReq | null;
    if (!b || typeof b !== 'object') return c.json({ error: 'JSON body required', code: 'BAD_REQUEST' }, 400);

    const intField = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
    const numField = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const next = { on_hand: p.on_hand, avg_daily_demand: p.avg_daily_demand, safety_stock: p.safety_stock };
    const changed: string[] = [];
    if (b.on_hand !== undefined) {
      if (!intField(b.on_hand)) return c.json({ error: 'on_hand must be an integer >= 0', code: 'BAD_REQUEST' }, 400);
      next.on_hand = b.on_hand!; changed.push(`on_hand ${p.on_hand}→${b.on_hand}`);
    }
    if (b.avg_daily_demand !== undefined) {
      if (!numField(b.avg_daily_demand)) return c.json({ error: 'avg_daily_demand must be a number >= 0', code: 'BAD_REQUEST' }, 400);
      next.avg_daily_demand = b.avg_daily_demand!; changed.push(`avg_daily_demand ${p.avg_daily_demand}→${b.avg_daily_demand}`);
    }
    if (b.safety_stock !== undefined) {
      if (!intField(b.safety_stock)) return c.json({ error: 'safety_stock must be an integer >= 0', code: 'BAD_REQUEST' }, 400);
      next.safety_stock = b.safety_stock!; changed.push(`safety_stock ${p.safety_stock}→${b.safety_stock}`);
    }
    if (!changed.length) return c.json({ error: 'nothing to update (on_hand, avg_daily_demand, safety_stock)', code: 'BAD_REQUEST' }, 400);

    getDb().prepare('UPDATE product SET on_hand = ?, avg_daily_demand = ?, safety_stock = ? WHERE sku = ?')
      .run(next.on_hand, next.avg_daily_demand, next.safety_stock, sku);
    audit.append(c.get('actor'), 'inventory.update', `${sku}: ${changed.join(', ')}`);
    publishInventory();
    const updated = product(sku)!;
    return c.json({ product: updated, recommendation: recommendationFor(updated) });
  });

  app.get('/api/suppliers', requirePermission('supplier:read'), (c) => {
    const sku = c.req.query('sku') || undefined;
    const offs = offers(sku);
    const ids = new Set(offs.map((o) => o.supplier_id));
    return c.json({ suppliers: suppliers().filter((s) => !sku || ids.has(s.id)), offers: offs });
  });

  app.post('/api/po', requirePermission('po:draft'), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sku?: string; supplier_id?: string; qty?: number; justification?: string } | null;
    const qty = Number(body?.qty);
    if (!body?.sku || !body.supplier_id || !Number.isInteger(qty) || qty <= 0) {
      return c.json({ error: 'sku, supplier_id, qty (positive integer) required', code: 'BAD_REQUEST' }, 400);
    }
    const offer = getDb().prepare('SELECT * FROM supplier_offer WHERE supplier_id = ? AND sku = ?').get(body.supplier_id, body.sku) as SupplierOffer | undefined;
    if (!offer) return c.json({ error: 'no offer for this sku/supplier', code: 'NOT_FOUND' }, 404);
    const id = newId('PO');
    const t = now();
    getDb()
      .prepare(`INSERT INTO purchase_order (id, sku, supplier_id, qty, unit_price, total, status, created_by, justification, created_at, updated_at)
                VALUES (?,?,?,?,?,?,'draft',?,?,?,?)`)
      .run(id, body.sku, body.supplier_id, qty, offer.unit_price, qty * offer.unit_price, c.get('actor'), String(body.justification ?? ''), t, t);
    audit.append(c.get('actor'), 'po.draft', id);
    const po = getPo(id)!;
    publish({ type: 'po.updated', po });
    return c.json(po, 201);
  });

  app.post('/api/po/:id/submit', requirePermission('po:submit'), async (c) => {
    const id = c.req.param('id');
    const actor = c.get('actor');
    const roles = c.get('roles');
    const row = poRow(id);
    if (!row) return c.json({ error: 'PO not found', code: 'NOT_FOUND' }, 404);
    if (!['draft', 'pending_approval', 'approved'].includes(row.status)) {
      return c.json({ error: `PO is ${row.status}`, code: 'CONFLICT' }, 409);
    }
    const p = product(row.sku)!;
    const sup = suppliers();
    const quorumApproved = row.status === 'approved' && roles.includes(ROLES.EXCEPTION_SUBMIT) && row.exception_used === 0;
    const result = evaluateSubmit(row, { label: actor, roles }, {
      now: now(),
      dailySpent: dailySpent(),
      supplier: sup.find((s) => s.id === row.supplier_id) ?? null,
      product: p,
      recommendation: recommendationFor(p, sup),
      quorumApproved,
    });
    let status = result.status;
    const checks = result.checks;
    let crId = row.change_request_id;

    // an approved PO that is re-evaluated without quorum stays approved (waiting for the right token)
    if (row.status === 'approved' && status === 'pending_approval') status = 'approved';

    if (status === 'pending_approval' && !crId && process.env.AUTH_MODE === 'dev' && process.env.SIM_QUORUM === '1') {
      // Offline demo: no TideCloak; /api/demo/approve/:id stands in for the quorum.
      crId = `sim-${id}`;
      audit.append(actor, 'po.exception_requested', `${id}:${crId}`);
    } else if (status === 'pending_approval' && !crId) {
      try {
        const iga = await deps.loadIga();
        if (typeof iga?.openExceptionRequest !== 'function') throw new Error('iga module not installed');
        const r = (await iga.openExceptionRequest(id, 'agent-planner')) as { change_request_id: string };
        crId = r.change_request_id;
        audit.append(actor, 'po.exception_requested', `${id}:${crId}`);
      } catch (e) {
        const q = checks.find((x) => x.rule === 'quorum');
        if (q) q.detail += ` (could not open change request: ${(e as Error).message})`;
      }
    }

    const db = getDb();
    db.transaction(() => {
      db.prepare('UPDATE purchase_order SET status = ?, checks_json = ?, change_request_id = ?, exception_used = ?, updated_at = ? WHERE id = ?')
        .run(status, JSON.stringify(checks), crId, quorumApproved && status === 'executed' ? 1 : row.exception_used, now(), id);
      if (status === 'executed') db.prepare('UPDATE product SET on_order = on_order + ? WHERE sku = ?').run(row.qty, row.sku);
    })();
    audit.append(actor, `po.submit.${status}${quorumApproved && status === 'executed' ? '.quorum' : ''}`, id);
    const po = getPo(id)!;
    publish({ type: 'po.updated', po });
    if (status === 'executed') publishInventory();
    return c.json(po);
  });

  app.get('/api/po', requirePermission('po:read'), (c) => {
    const st = c.req.query('status');
    const rows = (st
      ? getDb().prepare('SELECT * FROM purchase_order WHERE status = ? ORDER BY created_at DESC').all(st)
      : getDb().prepare('SELECT * FROM purchase_order ORDER BY created_at DESC').all()) as PoRow[];
    return c.json({ items: rows.map(toPo) });
  });

  app.post('/api/po/:id/exception-report', requirePermission('exception:report'), async (c) => {
    const id = c.req.param('id');
    if (!poRow(id)) return c.json({ error: 'PO not found', code: 'NOT_FOUND' }, 404);
    const b = (await c.req.json().catch(() => null)) as ExceptionReport | null;
    if (!b || typeof b.summary !== 'string' || !Array.isArray(b.risk_flags) || !['approve', 'reject', 'investigate'].includes(b.recommendation)) {
      return c.json({ error: 'body must be ExceptionReport', code: 'BAD_REQUEST' }, 400);
    }
    const rep: ExceptionReport = { summary: b.summary, risk_flags: b.risk_flags.map(String), recommendation: b.recommendation };
    getDb().prepare('UPDATE purchase_order SET exception_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(rep), now(), id);
    audit.append(c.get('actor'), 'po.exception_report', id);
    const po = getPo(id)!;
    publish({ type: 'po.updated', po });
    return c.json(po);
  });

  app.post('/api/agents/run', requirePermission('agents:run'), async (c) => {
    const runId = newId('run');
    getDb().prepare('INSERT INTO agent_run (id, started_by, started_at) VALUES (?,?,?)').run(runId, c.get('actor'), now());
    audit.append(c.get('actor'), 'agents.run', runId);
    const log = (agent: AgentName, step: string, message: string) => publish({ type: 'agent.log', agent, step, message, ts: Date.now() });
    const finish = (summary: string) =>
      getDb().prepare('UPDATE agent_run SET finished_at = ?, summary = ? WHERE id = ?').run(now(), summary, runId);
    const agents = await deps.loadAgents().catch(() => null);
    if (typeof agents?.runCycle !== 'function') {
      log('analyst', 'error', 'agents module not installed');
      finish('agents module not installed');
      return c.json({ run_id: runId }, 202);
    }
    const apiBase = process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? 4000}`;
    Promise.resolve()
      .then(() => agents.runCycle({ apiBase, runId, log }))
      .then((r: { summary?: string } | undefined) => finish(r?.summary ?? 'done'))
      .catch((e: Error) => {
        log('analyst', 'error', `run failed: ${e.message}`);
        finish(`error: ${e.message}`);
      });
    return c.json({ run_id: runId }, 202);
  });

  app.post('/api/demo/inject', requirePermission('demo:inject'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    const enabled = b.enabled !== false;
    injectMaliciousNote(enabled);
    audit.append(c.get('actor'), enabled ? 'demo.inject.on' : 'demo.inject.off', 'sup-buildfast');
    return c.json({ ok: true, enabled });
  });

  app.post('/api/demo/attack', requirePermission('demo:inject'), async (c) => {
    const agents = await deps.loadAgents().catch(() => null);
    if (typeof agents?.attackDirect !== 'function') return c.json({ error: 'agents module not installed', code: 'NOT_INSTALLED' }, 501);
    audit.append(c.get('actor'), 'demo.attack', null);
    return c.json(await agents.attackDirect());
  });

  app.post('/api/demo/reset', requirePermission('demo:inject'), (c) => {
    resetDemo();
    audit.append(c.get('actor'), 'demo.reset', null);
    publishInventory();
    return c.json({ ok: true });
  });

  // Named scenarios for judges: reset + deterministic data tweak; the story changes, the rules don't.
  app.post('/api/demo/preset', requirePermission('demo:inject'), async (c) => {
    const b = (await c.req.json().catch(() => null)) as { name?: string } | null;
    const name = String(b?.name ?? '') as DemoPresetName;
    try {
      const { preset, injected } = applyPreset(name);
      audit.append(c.get('actor'), 'demo.preset', name);
      publishInventory();
      return c.json({ ok: true as const, preset: name, description: preset.description, injected });
    } catch (e) {
      return c.json({ error: (e as Error).message, code: 'BAD_REQUEST' }, 400);
    }
  });

  app.get('/api/audit', requirePermission('audit:read'), (c) => {
    const v = audit.verify();
    return c.json({ items: audit.list(), valid: v.ok, broken_at: v.brokenAt });
  });

  app.get('/api/stream', (c) => streamHandler(c));

  return app;
}

/** Mount optional P3 routes (before 404 handling — Hono matches in registration order, routes are distinct). */
export async function mountOptional(app: Hono<AppEnv>, opts: { governance: boolean }) {
  const iga = await deps.loadIga();
  // Re-link change requests recorded in the DB so governance + friendly CR naming survive a restart.
  if (typeof iga?.trackChangeRequest === 'function') {
    const rows = getDb()
      .prepare("SELECT id, change_request_id FROM purchase_order WHERE change_request_id IS NOT NULL AND status IN ('pending_approval','approved')")
      .all() as { id: string; change_request_id: string }[];
    for (const r of rows) iga.trackChangeRequest(r.change_request_id, r.id, 'agent-planner');
  }
  if (typeof iga?.registerIgaRoutes === 'function') iga.registerIgaRoutes(app);
  if (!opts.governance) return;
  const gov = await optionalImport(GOV_SPEC);
  // Offline demo only: stands in for the TideCloak quorum. Real mode has no such route.
  if (process.env.AUTH_MODE === 'dev' && typeof gov?.simulateApproval === 'function') {
    app.post('/api/demo/approve/:id', (c) => c.json(gov.simulateApproval(c.req.param('id'))));
  }
  if (typeof gov?.startGovernance === 'function') {
    gov.startGovernance({
      onApproved: async (id: string) => {
        markApproved(id);
        const agents = await deps.loadAgents().catch(() => null);
        await agents?.retryApproved?.(id);
      },
      onRejected: (id: string) => markRejected(id),
      publish: (ev: StreamEvent) => publish(ev),
    });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { serve } = await import('@hono/node-server');
  setDb(openDb());
  const app = createApp();
  await mountOptional(app, { governance: true });
  const port = Number(process.env.PORT ?? 4000);
  serve({ fetch: app.fetch, port }, () => console.log(`procureguard server on :${port} (AUTH_MODE=${process.env.AUTH_MODE ?? 'jwt'})`));
}
