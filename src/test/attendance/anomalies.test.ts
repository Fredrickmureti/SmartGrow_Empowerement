import { describe, it, expect } from "vitest";
import { detectAnomalies } from "@/lib/attendance/anomalies";

const baseRecord = {
  attendance_date: "2026-01-15",
  clock_in: "2026-01-15T09:00:00Z",
  clock_out: "2026-01-15T17:00:00Z" as string | null,
  worked_hours: 8,
  overtime_hours: 0,
  status: "present",
  late_minutes: 0,
  early_leave_minutes: 0,
};

const NOW = new Date("2026-01-20T12:00:00Z");

describe("detectAnomalies", () => {
  it("flags missing clock-out on past days only", () => {
    const past = detectAnomalies({ ...baseRecord, clock_out: null }, null, NOW);
    expect(past.map((a) => a.code)).toContain("missing_out");

    // today (current day) — should NOT flag as missing
    const todayKey = NOW.toISOString().split("T")[0];
    const today = detectAnomalies(
      { ...baseRecord, attendance_date: todayKey, clock_in: NOW.toISOString(), clock_out: null },
      null,
      NOW,
    );
    expect(today.map((a) => a.code)).not.toContain("missing_out");
  });

  it("flags late when status=late or late_minutes>0", () => {
    expect(
      detectAnomalies({ ...baseRecord, status: "late" }, null, NOW).map((a) => a.code),
    ).toContain("late");
    expect(
      detectAnomalies({ ...baseRecord, late_minutes: 12 }, null, NOW).map((a) => a.code),
    ).toContain("late");
  });

  it("flags early leave when early_leave_minutes>0", () => {
    expect(
      detectAnomalies({ ...baseRecord, early_leave_minutes: 30 }, null, NOW).map((a) => a.code),
    ).toContain("early_leave");
  });

  it("flags over-threshold when worked_hours exceeds OT threshold by 4h", () => {
    const out = detectAnomalies(
      { ...baseRecord, worked_hours: 13 },
      { overtime_threshold_hours: 8 },
      NOW,
    );
    expect(out.map((a) => a.code)).toContain("over_threshold");
  });

  it("flags ot_no_preapproval only when settings require it AND overtime>0", () => {
    const withSetting = detectAnomalies(
      { ...baseRecord, overtime_hours: 2 },
      { require_ot_preapproval: true },
      NOW,
    );
    expect(withSetting.map((a) => a.code)).toContain("ot_no_preapproval");

    const withoutSetting = detectAnomalies(
      { ...baseRecord, overtime_hours: 2 },
      { require_ot_preapproval: false },
      NOW,
    );
    expect(withoutSetting.map((a) => a.code)).not.toContain("ot_no_preapproval");
  });

  it("returns empty for a clean record", () => {
    expect(detectAnomalies(baseRecord, null, NOW)).toEqual([]);
  });
});
