// Agent identities (D4/D8): each agent authenticates as its own TideCloak confidential client.
import { AGENT_CLIENTS, ROLES, type AgentName } from '../../../shared/types.ts';

const AGENT_ROLE: Record<AgentName, string> = {
  analyst: ROLES.AGENT_ANALYST,
  planner: ROLES.AGENT_PLANNER,
  exception: ROLES.AGENT_EXCEPTION,
};

const cache = new Map<AgentName, { token: string; exp: number }>();
let devElevated = false;

/** Dev mode only: emulate the IGA grant of proc.exception-submit to the planner. */
export function markDevElevated(on: boolean): void { devElevated = on; }
export function _resetTokenCache(): void { cache.clear(); }

export async function getAgentToken(
  name: AgentName,
  opts: { force?: boolean } = {},
): Promise<{ headers: Record<string, string> }> {
  const clientId = AGENT_CLIENTS[name];
  if (process.env.AUTH_MODE === 'dev') {
    const roles = [AGENT_ROLE[name]];
    if (name === 'planner' && (devElevated || process.env.DEV_PLANNER_ELEVATED === '1')) roles.push(ROLES.EXCEPTION_SUBMIT);
    return { headers: { 'X-Dev-Sub': clientId, 'X-Dev-Roles': roles.join(',') } };
  }

  const hit = cache.get(name);
  if (!opts.force && hit && Date.now() < hit.exp - 30_000) return { headers: { Authorization: `Bearer ${hit.token}` } };

  const base = (process.env.TIDECLOAK_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const realm = process.env.REALM || 'test1';
  const res = await fetch(`${base}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: process.env[`AGENT_${name.toUpperCase()}_SECRET`] ?? '',
    }).toString(),
  });
  if (!res.ok) throw new Error(`token ${clientId}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  cache.set(name, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 60) * 1000 });
  return { headers: { Authorization: `Bearer ${body.access_token}` } };
}
