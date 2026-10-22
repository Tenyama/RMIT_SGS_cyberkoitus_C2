// TideCloak IGA client (track A). Server side only ever *proposes* (revoke via tidewatch-sa)
// and *reads* change requests; approvers authorize/deny from the browser with their own token.
// IGA shapes measured from iga-core-1.0-SNAPSHOT.jar (IgaChangeRequestRepresentation,
// IgaPendingApprovalExceptionMapper: 202 {status, changeRequestId, ...} + Location header).
import type { Hono } from 'hono';
import { ROLES, type ChangeRequest, type ChangeRequestsRes } from '../../shared/types.ts';

export type IgaErrorCode = 'FORBIDDEN' | 'CONFLICT' | 'QUORUM_NOT_MET' | 'ENTITY_VANISHED' | 'UNEXPECTED';

export class IgaError extends Error {
  constructor(public code: IgaErrorCode, public status: number, message?: string) {
    super(message ?? `IGA ${code} (${status})`);
    this.name = 'IgaError';
  }
}

const STATUS_CODE: Record<number, IgaErrorCode> = { 403: 'FORBIDDEN', 409: 'CONFLICT', 412: 'QUORUM_NOT_MET', 404: 'ENTITY_VANISHED' };

function env() {
  const base = (process.env.TIDECLOAK_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const realm = process.env.REALM ?? 'tidewatch';
  return {
    base,
    realm,
    admin: `${base}/admin/realms/${encodeURIComponent(realm)}`,
    clientId: process.env.SA_CLIENT_ID ?? 'tidewatch-sa',
    secret: process.env.SA_CLIENT_SECRET ?? '',
  };
}

let tokenCache: { token: string; exp: number } | null = null;
const roleCache = new Map<string, Record<string, unknown>>();

/** Test hook: drop cached SA token and role representations. */
export function _resetIgaCache() {
  tokenCache = null;
  roleCache.clear();
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

async function getRoleRep(role: string): Promise<Record<string, unknown>> {
  const hit = roleCache.get(role);
  if (hit) return hit;
  const res = await adminFetch(`/roles/${encodeURIComponent(role)}`);
  if (!res.ok) await fail(res, `role ${role}`);
  const rep = (await res.json()) as Record<string, unknown>;
  roleCache.set(role, rep);
  return rep;
}

interface IgaCrRep {
  id: string;
  status?: string;
  entityType?: string;
  entityId?: string;
  actionType?: string;
  authorizationCount?: number;
  threshold?: number;
  createdAt?: number;
  resolvedAt?: number | null;
}

async function listRaw(status?: string): Promise<IgaCrRep[]> {
  const res = await adminFetch(`/iga/change-requests${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  if (!res.ok) await fail(res, 'list change-requests');
  const body = await res.json();
  return Array.isArray(body) ? body : [];
}

function toChangeRequest(r: IgaCrRep): ChangeRequest {
  return {
    id: r.id,
    status: r.status ?? 'UNKNOWN',
    summary: [r.actionType, r.entityType, r.entityId].filter(Boolean).join(' '),
    approvals: Number(r.authorizationCount ?? 0),
    required: Number(r.threshold || 2), // [inferred] threshold 0 = not computed yet; schema default is 2
    updated_at: Number(r.resolvedAt ?? r.createdAt ?? Date.now()), // [inferred] epoch ms
  };
}

export async function listChangeRequests(status?: string): Promise<ChangeRequest[]> {
  return (await listRaw(status)).map(toChangeRequest);
}

/**
 * Propose removing a realm role from a user. Under IGA the DELETE is captured (202) and becomes a
 * change request that needs approver quorum.
 */
export async function revokeRole(sub: string, role: string): Promise<{ change_request_id: string }> {
  const rep = await getRoleRep(role);
  const res = await adminFetch(`/users/${encodeURIComponent(sub)}/role-mappings/realm`, {
    method: 'DELETE',
    body: JSON.stringify([rep]),
  });
  if (res.status !== 202) {
    if (res.ok) throw new IgaError('UNEXPECTED', res.status, 'role removed directly: IGA not enabled on realm');
    await fail(res, 'revoke role');
  }
  // [inferred] id sources in order: body.changeRequestId, Location tail, newest PENDING CR for this user.
  const body = (await res.json().catch(() => null)) as { changeRequestId?: string; id?: string } | null;
  const fromBody = body?.changeRequestId ?? body?.id;
  if (fromBody) return { change_request_id: fromBody };
  const loc = res.headers.get('Location');
  const fromLoc = loc?.split('?')[0].split('/').filter(Boolean).pop();
  if (fromLoc) return { change_request_id: fromLoc };
  const mine = (await listRaw('PENDING'))
    .filter((r) => r.entityId === sub)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (mine[0]) return { change_request_id: mine[0].id };
  throw new IgaError('UNEXPECTED', 202, 'captured but change request id not found');
}

function httpStatus(e: IgaError): 403 | 404 | 409 | 412 | 502 {
  return e.status === 403 || e.status === 404 || e.status === 409 || e.status === 412 ? e.status : 502;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerIgaRoutes(app: Hono<any>) {
  app.get('/api/change-requests', async (c) => {
    const roles = c.get('roles') as string[] | undefined; // set by track C's auth middleware, if mounted
    if (Array.isArray(roles) && !roles.includes(ROLES.APPROVER)) return c.json({ error: 'forbidden' }, 403);
    try {
      const items = await listChangeRequests(c.req.query('status') || undefined);
      return c.json({ items } satisfies ChangeRequestsRes);
    } catch (e) {
      if (e instanceof IgaError) return c.json({ error: e.message, code: e.code }, httpStatus(e));
      throw e;
    }
  });
}
