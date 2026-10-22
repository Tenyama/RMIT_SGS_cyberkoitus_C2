import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { actorHash, remember } from './hmac.ts';

export type AppEnv = { Variables: { sub: string; actor_hash: string; roles: string[] } };

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    const base = process.env.TIDECLOAK_URL || 'http://localhost:8080';
    const realm = process.env.REALM || 'tidewatch';
    jwks = createRemoteJWKSet(new URL(`${base}/realms/${realm}/protocol/openid-connect/certs`));
  }
  return jwks;
}

type Claims = JWTPayload & {
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
};

export function rolesFromClaims(p: Claims): string[] {
  const realm = p.realm_access?.roles ?? [];
  const rm = p.resource_access?.['realm-management']?.roles ?? [];
  return [...new Set([...realm, ...rm])];
}

/** Resolve the caller. AUTH_MODE=jwt (default) verifies the TideCloak token; AUTH_MODE=dev trusts X-Dev-* headers (D9). */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  let sub: string | undefined;
  let roles: string[] = [];
  if (process.env.AUTH_MODE === 'dev') {
    // query fallback because EventSource cannot send headers
    sub = c.req.header('x-dev-sub') || c.req.query('dev_sub') || undefined;
    roles = (c.req.header('x-dev-roles') ?? c.req.query('dev_roles') ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  } else {
    const h = c.req.header('authorization');
    const token = h?.startsWith('Bearer ') ? h.slice(7) : c.req.query('access_token');
    if (token) {
      try {
        const { payload } = await jwtVerify<Claims>(token, getJwks(), { algorithms: ['EdDSA', 'RS256'] });
        sub = payload.sub;
        roles = rolesFromClaims(payload);
      } catch {
        sub = undefined;
      }
    }
  }
  if (!sub) return c.json({ error: 'unauthorized' }, 401);
  const hash = actorHash(sub);
  remember(hash, sub);
  c.set('sub', sub);
  c.set('actor_hash', hash);
  c.set('roles', roles);
  await next();
};

/** 403 unless the caller holds at least one of `roles`. */
export function requireRole(...roles: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const have = c.get('roles') ?? [];
    if (!roles.some((r) => have.includes(r))) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
}
