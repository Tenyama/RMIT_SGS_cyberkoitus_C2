import { afterEach, describe, expect, it, vi } from "vitest";
import { api, buildHeaders, devIdentity } from "./api.js";
import { streamUrl } from "./stream.js";

describe("devIdentity", () => {
  it("is null without VITE_DEV_ROLES", () => {
    expect(devIdentity({})).toBeNull();
    expect(devIdentity({ VITE_DEV_ROLES: " , " })).toBeNull();
  });
  it("defaults sub to staff1 and trims roles", () => {
    expect(devIdentity({ VITE_DEV_ROLES: "proc.buyer, proc.auditor" })).toEqual({
      sub: "staff1",
      roles: ["proc.buyer", "proc.auditor"],
    });
    expect(devIdentity({ VITE_DEV_ROLES: "proc.buyer", VITE_DEV_SUB: "boss" }).sub).toBe("boss");
  });
});

describe("buildHeaders", () => {
  const dev = { sub: "staff1", roles: ["proc.buyer", "proc.auditor"] };
  it("dev mode sends X-Dev headers and never a bearer", () => {
    const h = buildHeaders({ token: "jwt", dev });
    expect(h["X-Dev-Sub"]).toBe("staff1");
    expect(h["X-Dev-Roles"]).toBe("proc.buyer,proc.auditor");
    expect(h.Authorization).toBeUndefined();
  });
  it("real mode sends bearer only", () => {
    const h = buildHeaders({ token: "jwt", hasBody: true, dev: null });
    expect(h.Authorization).toBe("Bearer jwt");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["X-Dev-Sub"]).toBeUndefined();
  });
  it("real mode without token sends no auth", () => {
    expect(buildHeaders({ dev: null }).Authorization).toBeUndefined();
  });
});

describe("api()", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("passes dev headers + JSON body to fetch and parses JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "r1" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await api("/agents/run", { method: "POST", body: {}, dev: { sub: "s", roles: ["proc.buyer"] } });
    expect(r).toEqual({ run_id: "r1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/agents/run");
    expect(init.headers["X-Dev-Roles"]).toBe("proc.buyer");
    expect(init.body).toBe("{}");
  });
  it("throws with status and server error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden", code: "E" }), { status: 403 })));
    await expect(api("/audit", { dev: null, token: "t" })).rejects.toMatchObject({ status: 403, message: "forbidden", code: "E" });
  });
});

describe("streamUrl", () => {
  it("dev mode uses dev_sub/dev_roles query", () => {
    expect(streamUrl("jwt", { sub: "staff1", roles: ["a", "b"] })).toBe("/api/stream?dev_sub=staff1&dev_roles=a%2Cb");
  });
  it("real mode uses access_token", () => {
    expect(streamUrl("x.y.z", null)).toBe("/api/stream?access_token=x.y.z");
    expect(streamUrl(null, null)).toBe("/api/stream");
  });
});
