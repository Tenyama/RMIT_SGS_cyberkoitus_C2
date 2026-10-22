import { describe, expect, it } from "vitest";
import {
  computeKpis, formatVND, groupLogsByRun, groupPosByStatus, isSimulatedCr, mergeById, shortCrId, upsertById,
} from "./format.js";

describe("formatVND", () => {
  it("formats with en-US thousands commas and VND suffix", () => {
    expect(formatVND(80_000_000)).toBe("80,000,000 VND");
    expect(formatVND(1234.6)).toBe("1,235 VND");
  });
  it("treats junk as 0", () => {
    expect(formatVND(undefined)).toBe("0 VND");
    expect(formatVND("abc")).toBe("0 VND");
  });
});

describe("groupPosByStatus", () => {
  const pos = [
    { id: "a", status: "executed", updated_at: 1 },
    { id: "b", status: "blocked", updated_at: 2 },
    { id: "c", status: "executed", updated_at: 5 },
    { id: "d", status: "pending_approval", updated_at: 3 },
    { id: "e", status: "draft", updated_at: 4 },
    { id: "f", status: "rejected", updated_at: 4 },
    { id: "g", status: "approved", updated_at: 6 },
  ];
  it("puts each PO in its column, newest first, drops drafts, merges approved+rejected", () => {
    const g = groupPosByStatus(pos);
    expect(g.executed.map((p) => p.id)).toEqual(["c", "a"]);
    expect(g.blocked.map((p) => p.id)).toEqual(["b"]);
    expect(g.pending.map((p) => p.id)).toEqual(["d"]);
    expect(g.resolved.map((p) => p.id)).toEqual(["g", "f"]);
    expect(Object.values(g).flat().some((p) => p.id === "e")).toBe(false);
  });
  it("handles null input", () => {
    expect(groupPosByStatus(null).executed).toEqual([]);
  });
});

describe("computeKpis", () => {
  it("sums only today's agent-executed orders", () => {
    const now = new Date(2026, 9, 22, 12).getTime();
    const yesterday = new Date(2026, 9, 21, 12).getTime();
    const k = computeKpis(
      [
        { id: "1", status: "executed", total: 6_000_000, created_by: "agent-planner", updated_at: now },
        { id: "2", status: "executed", total: 9_000_000, created_by: "agent-planner", updated_at: yesterday },
        { id: "3", status: "executed", total: 1_000_000, created_by: "buyer", updated_at: now },
        { id: "4", status: "pending_approval", total: 80_000_000, created_by: "agent-planner", updated_at: now },
        { id: "5", status: "blocked", total: 5, created_by: "agent-planner", updated_at: now },
      ],
      now,
    );
    expect(k).toMatchObject({ executed: 3, blocked: 1, pending: 1, spent: 6_000_000, pct: 20 });
  });
});

describe("upsertById", () => {
  it("replaces existing and prepends new", () => {
    const l = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
    expect(upsertById(l, { id: "b", v: 2 })).toEqual([{ id: "a", v: 1 }, { id: "b", v: 2 }]);
    expect(upsertById(l, { id: "c", v: 1 })[0].id).toBe("c");
  });
});

describe("mergeById", () => {
  it("keeps one PO per id when it arrives via GET and SSE, newest wins", () => {
    const fetched = [{ id: "a", updated_at: 1, v: "get" }, { id: "b", updated_at: 1 }];
    const sse = [{ id: "a", updated_at: 2, v: "sse" }];
    const m = mergeById(fetched, sse);
    expect(m.map((x) => x.id).sort()).toEqual(["a", "b"]);
    expect(m.find((x) => x.id === "a").v).toBe("sse");
  });
  it("upsertById ignores items without id", () => {
    const l = [{ id: "a" }];
    expect(upsertById(l, undefined)).toBe(l);
  });
});

describe("groupLogsByRun", () => {
  it("returns runs newest-first with entries newest-first, capped", () => {
    const logs = [
      { key: 1, run: "r1", ts: 1, message: "a" },
      { key: 2, run: "r1", ts: 2, message: "b" },
      { key: 3, run: "r2", ts: 3, message: "c" },
      { key: 4, run: "r2", ts: 4, message: "d" },
    ];
    const g = groupLogsByRun(logs);
    expect(g.map((r) => r.run)).toEqual(["r2", "r1"]);
    expect(g[0].entries.map((e) => e.key)).toEqual([4, 3]);
    expect(groupLogsByRun(logs, 2).map((r) => r.run)).toEqual(["r2"]);
  });
});

describe("isSimulatedCr", () => {
  it("detects dev simulation ids", () => {
    expect(isSimulatedCr("sim-po_1")).toBe(true);
    expect(isSimulatedCr("8a1f")).toBe(false);
    expect(isSimulatedCr(null)).toBe(false);
  });
});

describe("shortCrId", () => {
  it("labels simulated requests, truncates uuids, keeps short ids", () => {
    expect(shortCrId("sim-PO-ab12")).toBe("simulated request");
    expect(shortCrId("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe("f47ac10b…");
    expect(shortCrId("cr-42")).toBe("cr-42");
    expect(shortCrId(null)).toBe("");
    expect(shortCrId(undefined)).toBe("");
  });
});
