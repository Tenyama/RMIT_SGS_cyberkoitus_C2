import { describe, expect, it } from "vitest";
import { computeKpis, formatVND, groupPosByStatus, upsertById } from "./format.js";

const norm = (s) => s.replace(/\s/g, " "); // Intl uses NBSP before ₫

describe("formatVND", () => {
  it("formats with vi-VN thousands dots and ₫", () => {
    expect(norm(formatVND(80_000_000))).toBe("80.000.000 ₫");
    expect(norm(formatVND(1234.6))).toBe("1.235 ₫");
  });
  it("treats junk as 0", () => {
    expect(norm(formatVND(undefined))).toBe("0 ₫");
    expect(norm(formatVND("abc"))).toBe("0 ₫");
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
  ];
  it("puts each PO in its column, newest first, drops drafts", () => {
    const g = groupPosByStatus(pos);
    expect(g.executed.map((p) => p.id)).toEqual(["c", "a"]);
    expect(g.blocked.map((p) => p.id)).toEqual(["b"]);
    expect(g.pending_approval.map((p) => p.id)).toEqual(["d"]);
    expect(g.approved).toEqual([]);
    expect(g.rejected.map((p) => p.id)).toEqual(["f"]);
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
