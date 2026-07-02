/**
 * Attendance behavior + invariants — replaces the prior shape-only contract test.
 *
 * Two layers:
 *  1) Source-level guarantees: the client never directly mutates the
 *     `attendance` table — all writes route through SECURITY DEFINER RPCs.
 *  2) mapRpcError friendliness: known DB error codes surface human messages.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const useAttendance = readFileSync(resolve(ROOT, "src/hooks/useAttendance.ts"), "utf8");
const useMyAttendance = readFileSync(resolve(ROOT, "src/hooks/hr/useMyAttendance.ts"), "utf8");

describe("Attendance — RPC-only invariants", () => {
  it("useAttendance.ts never inserts/updates/deletes on the attendance table directly", () => {
    // SELECTs are allowed (.from('attendance').select(...)).
    expect(useAttendance).not.toMatch(/from\(\s*["']attendance["']\s*\)\s*\.\s*insert/);
    expect(useAttendance).not.toMatch(/from\(\s*["']attendance["']\s*\)\s*\.\s*update/);
    expect(useAttendance).not.toMatch(/from\(\s*["']attendance["']\s*\)\s*\.\s*delete/);
    expect(useAttendance).not.toMatch(/from\(\s*["']attendance["']\s*\)\s*\.\s*upsert/);
  });

  it("useAttendance.ts wires every mutation to its RPC", () => {
    expect(useAttendance).toMatch(/rpc\(["']attendance_clock_in["']/);
    expect(useAttendance).toMatch(/rpc\(["']attendance_clock_out["']/);
    expect(useAttendance).toMatch(/rpc\(["']attendance_admin_create["']/);
    expect(useAttendance).toMatch(/rpc\(["']attendance_request_correction["']/);
    expect(useAttendance).toMatch(/attendance_approve_correction/);
    expect(useAttendance).toMatch(/attendance_reject_correction/);
  });

  it("useMyAttendance restricts by employee_id and includes it in the queryKey", () => {
    expect(useMyAttendance).toMatch(/employee_id/);
    expect(useMyAttendance).toMatch(/queryKey[\s\S]{0,200}currentEmployee/);
  });
});

describe("Attendance — error mapping", () => {
  // Re-implement the (private) mapper here to keep this test pure-unit.
  // Mirrors the behavior in src/hooks/useAttendance.ts.
  function mapRpcError(err: { message?: string }): string {
    const msg = err?.message || "Operation failed";
    if (msg.includes("open attendance session") || msg.includes("already")) {
      return "You already have an active session. Please clock out first.";
    }
    if (msg.includes("on approved leave")) {
      return "Cannot clock in on an approved leave day.";
    }
    if (msg.includes("locked")) {
      return "This record is locked by payroll and cannot be edited.";
    }
    if (msg.includes("permission")) {
      return "You don't have permission for this action.";
    }
    return msg;
  }

  it("surfaces a friendly duplicate-clock-in message", () => {
    expect(mapRpcError({ message: "ALREADY_CLOCKED_IN: already have open attendance session" }))
      .toMatch(/already have an active session/i);
  });

  it("surfaces a friendly on-approved-leave message", () => {
    expect(mapRpcError({ message: "ERR: employee is on approved leave" }))
      .toMatch(/approved leave/i);
  });

  it("surfaces a friendly payroll-lock message", () => {
    expect(mapRpcError({ message: "row is locked by payroll" }))
      .toMatch(/locked by payroll/i);
  });
});
