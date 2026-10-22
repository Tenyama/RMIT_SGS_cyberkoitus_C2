import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { maskDisplay, decryptMany, encryptKyc, beacon } from "../src/lib/tide.js";

function fakeTc(overrides = {}) {
  return {
    token: "tok-old",
    forceRefreshToken: vi.fn(async () => true),
    getToken: vi.fn(async () => "tok-new"),
    doEncrypt: vi.fn(async (items) => items.map((i) => `CT(${i.data})`)),
    doDecrypt: vi.fn(async (items) => items.map((i) => i.encrypted.slice(3, -1))),
    ...overrides,
  };
}

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const beaconBodies = () =>
  fetchMock.mock.calls
    .filter(([url]) => url === "/api/telemetry/decrypt")
    .map(([, init]) => JSON.parse(init.body));

describe("maskDisplay", () => {
  it("masks middle names and phone", () => {
    expect(maskDisplay("Nguyen Van A", "0912345123")).toBe("Nguyen V. A · 09***123");
  });
  it("handles multiple middle names, extra spaces and phone punctuation", () => {
    expect(maskDisplay("  Tran  Thi Ngoc  Anh ", "091-234-5678")).toBe("Tran T. N. Anh · 09***678");
  });
  it("handles single-word name and short/missing phone", () => {
    expect(maskDisplay("Lan", "123")).toBe("Lan · ***");
    expect(maskDisplay("", "")).toBe("? · ***");
  });
});

describe("encryptKyc", () => {
  it("calls doEncrypt once with kyc tag and returns ciphertext string", async () => {
    const tc = fakeTc();
    const ct = await encryptKyc(tc, { name: "A" });
    expect(tc.doEncrypt).toHaveBeenCalledTimes(1);
    expect(tc.doEncrypt.mock.calls[0][0]).toEqual([{ data: '{"name":"A"}', tags: ["kyc"] }]);
    expect(ct).toBe('CT({"name":"A"})');
  });
});

describe("decryptMany", () => {
  it("refreshes token, calls doDecrypt exactly once for N items, beacons count=N", async () => {
    const tc = fakeTc();
    const cts = [1, 2, 3].map((i) => `CT(${JSON.stringify({ i })})`);
    const out = await decryptMany(tc, cts);
    expect(out).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    expect(tc.forceRefreshToken).toHaveBeenCalledTimes(1);
    expect(tc.forceRefreshToken.mock.invocationCallOrder[0]).toBeLessThan(
      tc.doDecrypt.mock.invocationCallOrder[0],
    );
    expect(tc.doDecrypt).toHaveBeenCalledTimes(1);
    expect(tc.doDecrypt.mock.calls[0][0]).toEqual(cts.map((c) => ({ encrypted: c, tags: ["kyc"] })));
    const bodies = beaconBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ tag: "kyc", ok: true, count: 3 });
    expect(typeof bodies[0].latency_ms).toBe("number");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer tok-new");
    expect(init.keepalive).toBe(true);
  });

  it("decodes Uint8Array results", async () => {
    const tc = fakeTc({ doDecrypt: vi.fn(async () => [new TextEncoder().encode('{"x":1}')]) });
    expect(await decryptMany(tc, ["ct"])).toEqual([{ x: 1 }]);
  });

  it("beacons ok=false and rethrows when doDecrypt fails", async () => {
    const err = new Error("denied");
    const tc = fakeTc({ doDecrypt: vi.fn(async () => { throw err; }) });
    await expect(decryptMany(tc, ["a", "b"])).rejects.toBe(err);
    expect(beaconBodies()[0]).toMatchObject({ tag: "kyc", ok: false, count: 2 });
  });

  it("treats a null result (SDK not ready) as failure", async () => {
    const tc = fakeTc({ doDecrypt: vi.fn(async () => null) });
    await expect(decryptMany(tc, ["a"])).rejects.toThrow();
    expect(beaconBodies()[0]).toMatchObject({ ok: false, count: 1 });
  });

  it("still decrypts when beacon fetch rejects", async () => {
    fetchMock.mockImplementation(async () => { throw new Error("offline"); });
    const tc = fakeTc();
    await expect(decryptMany(tc, ['CT({"a":1})'])).resolves.toEqual([{ a: 1 }]);
  });
});

describe("beacon", () => {
  it("never throws when fetch rejects", async () => {
    fetchMock.mockImplementation(async () => { throw new Error("boom"); });
    expect(() => beacon("t", { tag: "kyc", ok: true, latency_ms: 1, count: 1 })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
  it("never throws when fetch throws synchronously or is missing", () => {
    fetchMock.mockImplementation(() => { throw new Error("sync"); });
    expect(() => beacon("t", { tag: "kyc", ok: true, latency_ms: 1, count: 1 })).not.toThrow();
    vi.stubGlobal("fetch", undefined);
    expect(() => beacon("t", { tag: "kyc", ok: true, latency_ms: 1, count: 1 })).not.toThrow();
  });
  it("returns undefined (does not block caller)", () => {
    expect(beacon("t", { tag: "kyc", ok: true, latency_ms: 1, count: 1 })).toBeUndefined();
  });
});
