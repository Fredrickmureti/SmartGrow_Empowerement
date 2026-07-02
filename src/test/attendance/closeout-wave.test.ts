/**
 * Closeout-wave invariants (source-level).
 *
 * These tests assert structural guarantees of the closeout wave without
 * touching the live database — they protect against regressions when the
 * relevant files are edited in the future.
 *
 * Layers covered:
 *  1) useAttendanceActions exposes break + OT controls (portal parity).
 *  2) compute-payroll branches on status='holiday' and writes holiday_hours.
 *  3) attendance.ingest verifies HMAC signature and enforces idempotency.
 *  4) LivePresenceCard renders an explicit scope label.
 *  5) AttendanceAudit goes through the attendance_events_search RPC.
 *  6) Hardware integration docs exist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("Closeout wave — portal parity", () => {
  const src = read("src/hooks/hr/useAttendanceActions.ts");
  it("exposes break + overtime RPC bindings", () => {
    expect(src).toMatch(/rpc\(\s*["']attendance_break_start["']/);
    expect(src).toMatch(/rpc\(\s*["']attendance_break_end["']/);
    expect(src).toMatch(/rpc\(\s*["']overtime_request_submit["']/);
    expect(src).toMatch(/startBreak[\s\S]{0,200}endBreak[\s\S]{0,200}requestOvertime/);
  });

  it("MyAttendance portal renders the unified clock widget", () => {
    const portal = read("src/pages/me/MyAttendance.tsx");
    expect(portal).toMatch(/AttendanceClockWidget/);
  });
});

describe("Closeout wave — payroll holiday handling", () => {
  const src = read("supabase/functions/compute-payroll/index.ts");
  it("aggregates holiday hours and writes holiday_hours into payroll_work_entries", () => {
    expect(src).toMatch(/totalHolidayHours/);
    expect(src).toMatch(/holiday_hours\s*:/);
  });
  it("treats worked-holiday as worked hours, otherwise expected hours", () => {
    expect(src).toMatch(/worked\s*>\s*0\s*\?\s*worked\s*:\s*expected/);
  });
});

describe("Closeout wave — hardware ingest endpoint", () => {
  const src = read("src/routes/api/public/attendance.ingest.ts");
  it("verifies HMAC and enforces ±300s timestamp skew", () => {
    expect(src).toMatch(/createHmac\(\s*["']sha256["']/);
    expect(src).toMatch(/timingSafeEqual/);
    expect(src).toMatch(/skew\s*>\s*300/);
  });
  it("enforces idempotency via attendance_ingest_log", () => {
    expect(src).toMatch(/attendance_ingest_log/);
    expect(src).toMatch(/payload_hash/);
    expect(src).toMatch(/idempotent\s*:\s*true/);
  });
});

describe("Closeout wave — presence scope label", () => {
  const src = read("src/components/attendance/LivePresenceCard.tsx");
  it("displays the active branch / workspace scope in the header", () => {
    expect(src).toMatch(/currentBranch\?\.name\s*\?\?\s*`All branches/);
  });
});

describe("Closeout wave — audit page server-side search", () => {
  const src = read("src/pages/hr/AttendanceAudit.tsx");
  it("uses the attendance_events_search RPC instead of client-side filter()", () => {
    expect(src).toMatch(/rpc\(\s*["']attendance_events_search["']/);
  });
});

describe("Closeout wave — integration docs", () => {
  it("attendance-hardware.md exists and documents HMAC + idempotency", () => {
    const path = "docs/integrations/attendance-hardware.md";
    expect(existsSync(resolve(ROOT, path))).toBe(true);
    const doc = read(path);
    expect(doc).toMatch(/HMAC/i);
    expect(doc).toMatch(/idempoten/i);
  });
});
