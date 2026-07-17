/**
 * Architecture guard — WMS Phase 7 (QC inspection lifecycle).
 *
 * QC writes must flow exclusively through the sanctioned RPCs:
 *   open_qc_inspection
 *   record_qc_check
 *   accept_qc_inspection
 *   reject_qc_inspection
 *   cancel_qc_inspection
 *
 * Every `warehouse.qc.*` event must be registered on the DomainEventType
 * union and handled by BusinessSagaMount.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const SELF = __filename;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("wms phase 7 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("no client code mutates wms_qc_inspections or wms_qc_inspection_checks directly", () => {
    const offenders: string[] = [];
    const banned = /from\(\s*["'](wms_qc_inspections|wms_qc_inspection_checks)["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (banned.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders, `QC writes must go through open_/record_/accept_/reject_/cancel_ RPCs:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("QC detail page calls the sanctioned RPCs", () => {
    const detail = readFileSync(path.join(SRC, "pages/warehouse/QCInspectionDetail.tsx"), "utf8");
    expect(/record_qc_check/.test(detail)).toBe(true);
    expect(/accept_qc_inspection/.test(detail)).toBe(true);
    expect(/reject_qc_inspection/.test(detail)).toBe(true);
    expect(/cancel_qc_inspection/.test(detail)).toBe(true);
  });

  it("all warehouse.qc.* events are registered in the domain bus and saga", () => {
    const bus = readFileSync(path.join(SRC, "services/events/domainEventBus.ts"), "utf8");
    const saga = readFileSync(path.join(SRC, "components/events/BusinessSagaMount.tsx"), "utf8");
    for (const type of ["opened", "accepted", "rejected", "cancelled"]) {
      expect(bus.includes(`warehouse.qc.${type}`), `bus missing warehouse.qc.${type}`).toBe(true);
      expect(saga.includes(`warehouse.qc.${type}`), `saga missing warehouse.qc.${type}`).toBe(true);
    }
  });
});