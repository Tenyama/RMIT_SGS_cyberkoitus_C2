import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Permission } from '../../shared/types.ts';
import { permissionsOf } from './policy.ts';

export type AppEnv = { Variables: { sub: string; actor: string; roles: string[]; permissions: Permission[] } };

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    const base = process.env.TIDECLOAK_URL || 'http://localhost:8080';
    const realm = process.env.REALM || 'test1';
    jwks = createRemoteJWKSet(new URL(`${base}/realms/${realm}/protocol/openid-connect/certs`));
  }
  return jwks;
}

type Claims = JWTPayload & {
  azp?: string;
  clientId?: string;
  preferred_username?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
};

export function rolesFromClaims(p: Claims): string[] {
  const realm = p.realm_access?.roles ?? [];
  const rm = p.resource_access?.['realm-management']?.roles ?? [];
  return [...new Set([...realm, ...rm])];
}

/** Service accounts → client id ("agent-planner"); humans → preferred_username. */
export function actorLabel(p: Claims): string {
  const pu = p.preferred_username;
  if (p.clientId) return p.clientId;
  if (pu?.startsWith('service-account-')) return p.azp ?? pu.slice('service-account-'.length);
  return pu ?? p.sub ?? 'unknown';
}

/** AUTH_MODE=jwt (default) verifies the TideCloak token; AUTH_MODE=dev trusts X-Dev-Sub / X-Dev-Roles (D8). */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  let sub: string | undefined;
  let actor: string | undefined;
  let roles: string[] = [];
  if (process.env.AUTH_MODE === 'dev') {
    // query fallback because EventSource cannot send headers
    sub = c.req.header('x-dev-sub') || c.req.query('dev_sub') || undefined;
    actor = sub;
    roles = (c.req.header('x-dev-roles') ?? c.req.query('dev_roles') ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  } else {
    const h = c.req.header('authorization');
    const token = h?.startsWith('Bearer ') ? h.slice(7) : c.req.query('access_token');
    if (token) {
      try {
        const { payload } = await jwtVerify<Claims>(token, getJwks(), { algorithms: ['EdDSA', 'RS256'] });
        sub = payload.sub;
        actor = actorLabel(payload);
        roles = rolesFromClaims(payload);
      } catch {
        sub = undefined;
      }
    }
  }
  if (!sub || !actor) return c.json({ error: 'unauthorized', code: 'UNAUTHORIZED' }, 401);
  c.set('sub', sub);
  c.set('actor', actor);
  c.set('roles', roles);
  c.set('permissions', permissionsOf(roles) as Permission[]);
  await next();
};

/** 403 unless the caller's roles grant `p` via PERMISSIONS. */
export function requirePermission(p: Permission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!(c.get('permissions') ?? []).includes(p)) return c.json({ error: `missing permission ${p}`, code: 'FORBIDDEN' }, 403);
    await next();
  };
}

/** 403 unless the caller holds at least one of `roles`. */
export function requireRole(...roles: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const have = c.get('roles') ?? [];
    if (!roles.some((r) => have.includes(r))) return c.json({ error: 'forbidden', code: 'FORBIDDEN' }, 403);
    await next();
  };
}
