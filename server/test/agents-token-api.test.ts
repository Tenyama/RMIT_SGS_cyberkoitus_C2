import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAgentToken, markDevElevated, _resetTokenCache } from '../src/agents/token.ts';
import { call, setApiBase } from '../src/agents/api.ts';
import { json } from './agents-fixtures.ts';

const env = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetTokenCache();
  markDevElevated(false);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...env };
});

describe('token (jwt mode)', () => {
  beforeEach(() => {
    process.env.AUTH_MODE = 'jwt';
    process.env.TIDECLOAK_URL = 'http://kc.test';
    delete process.env.REALM;
    process.env.AGENT_PLANNER_SECRET = 's3cret';
  });

  it('posts client_credentials to the realm token endpoint and caches the token', async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => json(200, { access_token: `tok${++n}`, expires_in: 300 }));
    const a = await getAgentToken('planner');
    const b = await getAgentToken('planner');
    expect(a.headers.Authorization).toBe('Bearer tok1');
    expect(b.headers.Authorization).toBe('Bearer tok1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://kc.test/realms/test1/protocol/openid-connect/token');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('agent-planner');
    expect(body.get('client_secret')).toBe('s3cret');
  });

  it('force fetches a fresh token', async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => json(200, { access_token: `tok${++n}`, expires_in: 300 }));
    await getAgentToken('planner');
    const f = await getAgentToken('planner', { force: true });
    expect(f.headers.Authorization).toBe('Bearer tok2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes 30s before expiry', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let n = 0;
    fetchMock.mockImplementation(async () => json(200, { access_token: `tok${++n}`, expires_in: 60 }));
    await getAgentToken('planner');
    vi.setSystemTime(1_000_000 + 29_000);
    expect((await getAgentToken('planner')).headers.Authorization).toBe('Bearer tok1');
    vi.setSystemTime(1_000_000 + 31_000);
    expect((await getAgentToken('planner')).headers.Authorization).toBe('Bearer tok2');
  });

  it('throws on token endpoint failure', async () => {
    fetchMock.mockResolvedValue(json(401, { error: 'unauthorized_client' }));
    await expect(getAgentToken('planner')).rejects.toThrow(/401/);
  });
});

describe('token (dev mode)', () => {
  beforeEach(() => { process.env.AUTH_MODE = 'dev'; delete process.env.DEV_PLANNER_ELEVATED; });
  it('sends X-Dev headers with the agent role', async () => {
    const t = await getAgentToken('analyst');
    expect(t.headers).toEqual({ 'X-Dev-Sub': 'agent-analyst', 'X-Dev-Roles': 'agent.analyst' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('planner gets exception-submit only when elevated', async () => {
    expect((await getAgentToken('planner')).headers['X-Dev-Roles']).toBe('agent.planner');
    markDevElevated(true);
    expect((await getAgentToken('planner')).headers['X-Dev-Roles']).toBe('agent.planner,proc.exception-submit');
    expect((await getAgentToken('exception')).headers['X-Dev-Roles']).toBe('agent.exception');
    markDevElevated(false);
    process.env.DEV_PLANNER_ELEVATED = '1';
    expect((await getAgentToken('planner')).headers['X-Dev-Roles']).toBe('agent.planner,proc.exception-submit');
  });
});

describe('api.call', () => {
  beforeEach(() => { process.env.AUTH_MODE = 'dev'; setApiBase('http://api.test'); });
  it('returns 403 instead of throwing, with agent headers', async () => {
    fetchMock.mockResolvedValue(json(403, { error: 'forbidden' }));
    const r = await call('analyst', 'POST', '/api/po', { a: 1 });
    expect(r).toEqual({ status: 403, json: { error: 'forbidden' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/api/po');
    expect(init.headers['X-Dev-Sub']).toBe('agent-analyst');
    expect(init.body).toBe('{"a":1}');
  });
  it('network error becomes status 0, not a throw', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await call('analyst', 'GET', '/api/inventory');
    expect(r.status).toBe(0);
  });
});
