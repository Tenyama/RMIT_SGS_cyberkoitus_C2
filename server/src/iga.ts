// TideCloak IGA client (track P3). The server only ever *opens* change requests (via tidewatch-sa)
// and *reads* them; approvers authorize in the TideCloak admin console with their Tide enclave.
// Shapes measured on realm test1: realm changes → 202 {changeRequestId} (sometimes 204, D9);
// GET /iga/change-requests/{id} → {id, entityType, entityId, actionType, rows, status,
// authorizationCount, threshold, readyToCommit, createdAt, resolvedAt, ...}; unknown id → 404;
// listing without ?status= returns [] so we always pass one.
import type { Hono } from 'hono';
import { ROLES, type ChangeRequest, type ChangeRequestsRes } from '../../shared/types.ts';

export type IgaErrorCode =
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'QUORUM_NOT_MET'
  | 'ENTITY_VANISHED'
  | 'ROLE_STILL_GRANTED' // agent still holds proc.exception-submit; a revoke CR must be approved first (manual)
  | 'UNEXPECTED';

export class IgaError extends Error {
  constructor(public code: IgaErrorCode, public status: number, message?: string) {
    super(message ?? `IGA ${code} (${status})`);
    this.name = 'IgaError';
  }
}

const STATUS_CODE: Record<number, IgaErrorCode> = { 403: 'FORBIDDEN', 409: 'CONFLICT', 412: 'QUORUM_NOT_MET', 404: 'ENTITY_VANISHED' };

function env() {
  const base = (process.env.TIDECLOAK_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const realm = process.env.REALM ?? 'test1';
  return {
    base,
    realm,
    admin: `${base}/admin/realms/${encodeURIComponent(realm)}`,
    clientId: process.env.SA_CLIENT_ID ?? 'tidewatch-sa',
    secret: process.env.SA_CLIENT_SECRET ?? '',
  };
}

// ---------- tracked CRs (crId -> PO) ----------
export interface TrackedCr {
  poId: string;
  agentClientId: string;
  simulated?: boolean; // dev-only synthetic approval (governance.simulateApproval)
}
const tracked = new Map<string, TrackedCr>();

/** Register a CR → PO link (openExceptionRequest does this; P1 may call it on boot to rehydrate from DB). */
export function trackChangeRequest(crId: string, poId: string, agentClientId = ''): void {
  tracked.set(crId, { poId, agentClientId });
}
export function untrackChangeRequest(crId: string): void {
  tracked.delete(crId);
}
export function trackedChangeRequests(): [string, TrackedCr][] {
  return [...tracked.entries()];
}
export function poIdFor(crId: string): string | null {
  return tracked.get(crId)?.poId ?? null;
}

let tokenCache: { token: string; exp: number } | null = null;
const roleCache = new Map<string, Record<string, unknown>>();

/** Test hook: drop cached SA token, role representations and tracked CRs. */
export function _resetIgaCache() {
  tokenCache = null;
  roleCache.clear();
  tracked.clear();
}

async function fail(res: Response, what: string): Promise<never> {
  const text = await res.text().catch(() => '');
  if (res.status === 401) tokenCache = null;
  throw new IgaError(STATUS_CODE[res.status] ?? 'UNEXPECTED', res.status, `${what}: ${res.status} ${text.slice(0, 200)}`);
}

export async function getSaToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.token;
  const e = env();
  const res = await fetch(`${e.base}/realms/${encodeURIComponent(e.realm)}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: e.clientId, client_secret: e.secret }).toString(),
  });
  if (!res.ok) await fail(res, 'sa token');
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  const ttlMs = Math.max(1, (body.expires_in ?? 60) - 5) * 1000; // refresh 5s early
  tokenCache = { token: body.access_token, exp: Date.now() + ttlMs };
  return body.access_token;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getSaToken();
  return fetch(`${env().admin}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
}

async function adminJson<T>(path: string, what: string): Promise<T> {
  const res = await adminFetch(path);
  if (!res.ok) await fail(res, what);
  return (await res.json()) as T;
}

async function getRoleRep(role: string): Promise<Record<string, unknown>> {
  const hit = roleCache.get(role);
  if (hit) return hit;
  const rep = await adminJson<Record<string, unknown>>(`/roles/${encodeURIComponent(role)}`, `role ${role}`);
  roleCache.set(role, rep);
  return rep;
}

async function serviceAccountUserId(clientId: string): Promise<string> {
  const clients = await adminJson<{ id: string }[]>(`/clients?clientId=${encodeURIComponent(clientId)}`, `client ${clientId}`);
  if (!clients[0]) throw new IgaError('ENTITY_VANISHED', 404, `client ${clientId} not found`);
  const user = await adminJson<{ id: string }>(`/clients/${encodeURIComponent(clients[0].id)}/service-account-user`, `sa user ${clientId}`);
  return user.id;
}

interface IgaCrRep {
  id: string;
  status?: string;
  entityType?: string;
  entityId?: string;
  actionType?: string;
  rows?: Record<string, string>[];
  authorizationCount?: number;
  threshold?: number;
  createdAt?: number;
  resolvedAt?: number | null;
}

async function listRaw(status: string): Promise<IgaCrRep[]> {
  const body = await adminJson<unknown>(`/iga/change-requests?status=${encodeURIComponent(status)}`, 'list change-requests');
  return Array.isArray(body) ? (body as IgaCrRep[]) : [];
}

function toChangeRequest(r: IgaCrRep): ChangeRequest {
  const t = tracked.get(r.id);
  return {
    id: r.id,
    status: r.status ?? 'UNKNOWN',
    summary: t
      ? `Grant ${ROLES.EXCEPTION_SUBMIT} to ${t.agentClientId || 'agent'} (PO ${t.poId})`
      : [r.actionType, r.entityType, r.entityId].filter(Boolean).join(' '),
    approvals: Number(r.authorizationCount ?? 0),
    required: Number(r.threshold ?? 1), // measured threshold=1 on test1
    updated_at: Number(r.resolvedAt ?? r.createdAt ?? Date.now()), // epoch ms (measured)
  };
}

/** status defaults to PENDING: IGA returns [] when no status is given [measured]. */
export async function listChangeRequests(status = 'PENDING'): Promise<ChangeRequest[]> {
  return (await listRaw(status)).map(toChangeRequest);
}

export async function getChangeRequest(id: string): Promise<ChangeRequest> {
  return toChangeRequest(await adminJson<IgaCrRep>(`/iga/change-requests/${encodeURIComponent(id)}`, `change-request ${id}`));
}

/**
 * Open the exception CR (D7): GRANT proc.exception-submit → the agent's service-account user.
 * Approvers authorize it in TideCloak; governance.ts watches it. Revoking afterwards is a manual CR.
 */
export async function openExceptionRequest(poId: string, agentClientId: string): Promise<{ change_request_id: string }> {
  const saUser = await serviceAccountUserId(agentClientId);
  const rep = await getRoleRep(ROLES.EXCEPTION_SUBMIT);
  const held = await adminJson<{ name?: string }[]>(`/users/${encodeURIComponent(saUser)}/role-mappings/realm`, 'role mappings');
  if (held.some((r) => r.name === ROLES.EXCEPTION_SUBMIT)) {
    throw new IgaError('ROLE_STILL_GRANTED', 409, `${agentClientId} still holds ${ROLES.EXCEPTION_SUBMIT}; approve a revoke CR first`);
  }
  const res = await adminFetch(`/users/${encodeURIComponent(saUser)}/role-mappings/realm`, {
    method: 'POST',
    body: JSON.stringify([rep]),
  });
  if (!res.ok) await fail(res, 'grant exception role');

  let id: string | undefined;
  if (res.status === 202) {
    const body = (await res.json().catch(() => null)) as { changeRequestId?: string } | null;
    id = body?.changeRequestId;
  }
  if (!id) {
    // D9: 204 (or 202 without id) still created a CR — newest PENDING GRANT_ROLES for this user.
    const mine = (await listRaw('PENDING'))
      .filter((r) => r.entityId === saUser && r.actionType === 'GRANT_ROLES')
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    id = mine[0]?.id;
  }
  if (!id) throw new IgaError('UNEXPECTED', res.status, 'grant accepted but no change request found (IGA off?)');
  trackChangeRequest(id, poId, agentClientId);
  return { change_request_id: id };
}

function httpStatus(e: IgaError): 403 | 404 | 409 | 412 | 502 {
  return e.status === 403 || e.status === 404 || e.status === 409 || e.status === 412 ? e.status : 502;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerIgaRoutes(app: Hono<any>) {
  app.get('/api/change-requests', async (c) => {
    const roles = c.get('roles') as string[] | undefined; // set by P1 auth middleware, if mounted
    if (Array.isArray(roles) && !roles.includes(ROLES.APPROVER)) return c.json({ error: 'forbidden' }, 403);
    try {
      const items = (await listChangeRequests(c.req.query('status') || undefined)).map((cr) => ({ ...cr, po_id: poIdFor(cr.id) }));
      return c.json({ items } satisfies ChangeRequestsRes);
    } catch (e) {
      if (e instanceof IgaError) return c.json({ error: e.message, code: e.code }, httpStatus(e));
      throw e;
    }
  });
}
