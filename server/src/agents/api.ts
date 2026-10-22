// Agents call OUR HTTP API like any external client, with their own token (D4). Never throws:
// agents must observe denials (4xx) and failures (status 0 = network/token error).
import type { AgentName } from '../../../shared/types.ts';
import { getAgentToken } from './token.ts';

let apiBase = process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? 4000}`;
export const setApiBase = (b: string): void => { apiBase = b.replace(/\/$/, ''); };
export const getApiBase = (): string => apiBase;

export interface ApiResult<T = any> { status: number; json: T }

export async function call<T = any>(
  name: AgentName,
  method: string,
  path: string,
  body?: unknown,
  opts: { force?: boolean } = {},
): Promise<ApiResult<T>> {
  let headers: Record<string, string>;
  try {
    headers = (await getAgentToken(name, opts)).headers;
  } catch (e) {
    return { status: 0, json: { error: `token: ${(e as Error).message}` } as T };
  }
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { error: text }; }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { error: (e as Error).message } as T };
  }
}
