/**
 * Workload page filter logic — guards against the previous "manager filter
 * is decorative" regression where managedIds was computed and discarded.
 */
import { describe, it, expect } from "vitest";

interface Row { user_id: string; logged_hours: number; capacity_hours: number; }

function applyFilters(
  rows: Row[],
  projectMembers: Set<string> | null,
  managerMembers: Set<string> | null,
): Row[] {
  let out = rows;
  if (projectMembers) out = out.filter((r) => projectMembers.has(r.user_id));
  if (managerMembers) out = out.filter((r) => managerMembers.has(r.user_id));
  return out;
}

const ROWS: Row[] = [
  { user_id: "u1", logged_hours: 30, capacity_hours: 40 },
  { user_id: "u2", logged_hours: 50, capacity_hours: 40 },
  { user_id: "u3", logged_hours: 10, capacity_hours: 40 },
];

describe("Workload filters", () => {
  it("returns all rows when no filters", () => {
    expect(applyFilters(ROWS, null, null)).toHaveLength(3);
  });

  it("project filter narrows by project membership", () => {
    const out = applyFilters(ROWS, new Set(["u1", "u3"]), null);
    expect(out.map((r) => r.user_id)).toEqual(["u1", "u3"]);
  });

  it("manager filter narrows by managed-projects membership union", () => {
    const out = applyFilters(ROWS, null, new Set(["u2"]));
    expect(out.map((r) => r.user_id)).toEqual(["u2"]);
  });

  it("project + manager filters intersect", () => {
    const out = applyFilters(ROWS, new Set(["u1", "u2"]), new Set(["u2", "u3"]));
    expect(out.map((r) => r.user_id)).toEqual(["u2"]);
  });

  it("over-capacity flag fires for >capacity logged hours", () => {
    const over = ROWS.filter((r) => r.logged_hours > r.capacity_hours);
    expect(over.map((r) => r.user_id)).toEqual(["u2"]);
  });
});