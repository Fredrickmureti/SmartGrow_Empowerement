/**
 * Architecture guard — hardware_exec_log audit-trail propagation.
 *
 * Track A wired source_doc_type / source_doc_id / business_event_id /
 * is_reprint end-to-end through HardwareClient.exec → recordHardwareExec.
 * Without this guard, a future refactor could silently drop one of the
 * audit fields and we'd be back to 100% NULL audit columns.
 *
 * What this test asserts:
 *  1. HardwareExecLog.recordHardwareExec input AND insert mapping still
 *     reference all four audit columns.
 *  2. HardwareClient.execAny still calls peelAuditFromPayload and forwards
 *     all four fields into recordHardwareExec.
 *  3. BusinessSagaMount.tsx and labelDispatch.ts pass sourceDocId AND
 *     businessEventId on every hardwareClient.exec call so the audit chain
 *     is never broken at the source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

function read(rel: string) {
  return readFileSync(path.join(SRC, rel), "utf8");
}

describe("hardware_exec_log carries audit columns", () => {
  const logFile = read("services/hardware/HardwareExecLog.ts");
  const clientFile = read("services/hardware/HardwareClient.ts");

  it("HardwareExecLog defines and writes all four audit columns", () => {
    for (const field of ["sourceDocType", "sourceDocId", "businessEventId", "isReprint"]) {
      expect(logFile, `${field} missing from HardwareExecLogEntry`).toMatch(new RegExp(`\\b${field}\\b`));
    }
    for (const col of ["source_doc_type", "source_doc_id", "business_event_id", "is_reprint"]) {
      expect(logFile, `${col} missing from insert mapping`).toContain(col);
    }
  });

  it("HardwareClient.execAny peels audit and forwards every field", () => {
    expect(clientFile).toMatch(/peelAuditFromPayload/);
    expect(clientFile).toMatch(/recordHardwareExec\(\{[\s\S]*?sourceDocType[\s\S]*?sourceDocId[\s\S]*?businessEventId[\s\S]*?isReprint[\s\S]*?\}\)/);
  });

  it("HardwareClient.exec public signature exposes audit fields", () => {
    expect(clientFile).toMatch(/sourceDocType\?:/);
    expect(clientFile).toMatch(/sourceDocId\?:/);
    expect(clientFile).toMatch(/businessEventId\?:/);
    expect(clientFile).toMatch(/isReprint\?:/);
  });
});

describe("saga + label dispatch always pass audit linkage", () => {
  it("BusinessSagaMount passes audit fields on every hardwareClient.exec call", () => {
    const f = read("components/events/BusinessSagaMount.tsx");
    // Every exec call must include sourceDocId AND businessEventId.
    const execBlocks = f.match(/hardwareClient\.exec\(\{[\s\S]*?\}\)/g) ?? [];
    expect(execBlocks.length, "expected at least one hardwareClient.exec call").toBeGreaterThan(0);
    for (const block of execBlocks) {
      expect(block, `audit fields missing: ${block}`).toMatch(/sourceDocId/);
      expect(block, `businessEventId missing: ${block}`).toMatch(/businessEventId/);
    }
  });

  it("labelDispatch passes audit fields on every dispatch path", () => {
    const f = read("services/printing/labelDispatch.ts");
    // Phase 5 Step B — labelDispatch no longer dispatches at a bare role.
    // Both paths (bound assignment, resolver fallback) must carry audit.
    expect(f).not.toMatch(/hardwareClient\.exec\(\{/);
    const blocks = [
      f.match(/hardwareClient\.execAssignment\(\{[\s\S]*?\n  \}\)/)?.[0] ?? "",
      f.match(/execForIntent\(\{[\s\S]*?\n    \}\)/)?.[0] ?? "",
    ];
    for (const block of blocks) {
      expect(block.length, "dispatch block not found").toBeGreaterThan(0);
      expect(block).toMatch(/sourceDocType/);
      expect(block).toMatch(/sourceDocId/);
      expect(block).toMatch(/businessEventId/);
    }
  });
});
