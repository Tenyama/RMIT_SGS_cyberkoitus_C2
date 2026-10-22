import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startGovernance, simulateApproval } from '../src/governance.ts';
import { _resetIgaCache, trackChangeRequest, trackedChangeRequests } from '../src/iga.ts';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let crs: Record<string, { status: string; authorizationCount: number } | null>;

beforeEach(() => {
  vi.useFakeTimers();
  process.env.TIDECLOAK_URL = 'http://kc.test';
  delete process.env.REALM;
  delete process.env.AUTH_MODE;
  _resetIgaCache();
  crs = {};
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/openid-connect/token')) return json(200, { access_token: 't', expires_in: 300 });
    const id = url.split('/iga/change-requests/')[1];
    const cr = id ? crs[id] : undefined;
    if (cr === null) return json(404, {});
    if (cr) return json(200, { id, ...cr, threshold: 1, createdAt: 1 });
    return json(500, {});
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startGovernance', () => {
  it('fires onApproved exactly once and publishes cr.updated on each change', async () => {
    trackChangeRequest('cr-1', 'po-1', 'agent-planner');
    crs['cr-1'] = { status: 'PENDING', authorizationCount: 0 };
    const onApproved = vi.fn();
    const onRejected = vi.fn();
    const publish = vi.fn();
    const stop = startGovernance({ onApproved, onRejected, publish });
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000); // unchanged → no second publish
    expect(publish).toHaveBeenCalledTimes(1);
    crs['cr-1'] = { status: 'APPROVED', authorizationCount: 1 };
    await vi.advanceTimersByTimeAsync(3000);
    crs['cr-1'] = { status: 'COMMITTED', authorizationCount: 1 };
    await vi.advanceTimersByTimeAsync(9000);
    stop();
    expect(onApproved).toHaveBeenCalledTimes(1);
    expect(onApproved).toHaveBeenCalledWith('po-1');
    expect(onRejected).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith({ type: 'cr.updated', id: 'cr-1', status: 'APPROVED', approvals: 1, required: 1, po_id: 'po-1' });
    expect(trackedChangeRequests()).toHaveLength(0);
  });

  it('DENIED → onRejected; 404 → onRejected', async () => {
    trackChangeRequest('cr-d', 'po-d');
    trackChangeRequest('cr-gone', 'po-g');
    crs['cr-d'] = { status: 'DENIED', authorizationCount: 0 };
    crs['cr-gone'] = null;
    const onApproved = vi.fn();
    const onRejected = vi.fn();
    const stop = startGovernance({ onApproved, onRejected });
    await vi.advanceTimersByTimeAsync(6000);
    stop();
    expect(onRejected.mock.calls.map((c) => c[0]).sort()).toEqual(['po-d', 'po-g']);
    expect(onApproved).not.toHaveBeenCalled();
  });
});

describe('simulateApproval', () => {
  it('throws outside AUTH_MODE=dev', () => {
    expect(() => simulateApproval('po-1')).toThrow(/AUTH_MODE=dev/);
    process.env.AUTH_MODE = 'jwt';
    expect(() => simulateApproval('po-1')).toThrow(/quorum/);
  });

  it('dev: next tick fires onApproved without calling TideCloak', async () => {
    process.env.AUTH_MODE = 'dev';
    const onApproved = vi.fn();
    const stop = startGovernance({ onApproved, onRejected: vi.fn() });
    expect(simulateApproval('po-s')).toEqual({ change_request_id: 'sim-po-s' });
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    expect(onApproved).toHaveBeenCalledTimes(1);
    expect(onApproved).toHaveBeenCalledWith('po-s');
    expect(fetch).not.toHaveBeenCalled();
  });
});
