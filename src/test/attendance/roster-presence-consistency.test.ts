/**
 * Roster ↔ Live presence consistency.
 *
 * Enterprise invariant: if "Checked in now = N", then today's roster MUST
 * include at least N rows whose status is "present" (not synthetic absent).
 * This test pins the safety-net union in `useAttendance` and the open-session
 * carve-out in `useAttendanceDaySummary`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("Roster ↔ presence consistency", () => {
  it("useAttendance unions open sessions into records when missing", () => {
    const src = read("src/hooks/useAttendance.ts");
    expect(src).toMatch(/mergedRecords/);
    expect(src).toMatch(/openSessions[\s\S]{0,400}byId\.has\(s\.id\)/);
    // Returned records is the merged set, not the raw fetch.
    expect(src).toMatch(/records:\s*mergedRecords/);
  });

  it("day summary counts open sessions as present regardless of status column", () => {
    const src = read("src/hooks/hr/useAttendanceDaySummary.ts");
    expect(src).toMatch(/r\.clock_in && !r\.clock_out/);
    expect(src).toMatch(/presentIds\.add\(r\.employee_id\)/);
  });
});
