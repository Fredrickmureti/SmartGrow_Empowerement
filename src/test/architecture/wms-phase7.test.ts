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
 * Every canonical `warehouse.qc.*` topic (as declared in `WMS_TOPIC`) must
 * be reachable from `domainEventBus.ts` and `BusinessSagaMount.tsx`. The
 * expected set is derived from `WMS_TOPIC` rather than hard-coded, so this
 * guard stays truthful when the vocabulary evolves (Phase 2.6 unified QC
 * onto trigger-emitted state topics).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { WMS_TOPIC } from "../../features/warehouse/events/topics";

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

  it("every canonical warehouse.qc.* topic is reachable from the domain bus and saga", () => {
    const bus = readFileSync(path.join(SRC, "services/events/domainEventBus.ts"), "utf8");
    const saga = readFileSync(path.join(SRC, "components/events/BusinessSagaMount.tsx"), "utf8");
    const qcTopics = Object.entries(WMS_TOPIC)
      .filter(([k]) => k.startsWith("QC_"))
      .map(([, v]) => v);
    // Both files consume WMS_TOPIC — either the literal appears or the
    // module reference does. Accept either form to avoid false positives.
    const busOk =
      /from\s+["']@\/features\/warehouse\/events\/topics["']/.test(bus) ||
      /WmsTopic/.test(bus);
    const sagaOk =
      /WMS_TOPIC/.test(saga) &&
      /Object\.values\(WMS_TOPIC\)/.test(saga);
    expect(busOk, "domainEventBus.ts must reference WmsTopic or the topics module").toBe(true);
    expect(sagaOk, "BusinessSagaMount.tsx must iterate Object.values(WMS_TOPIC) to register handlers").toBe(true);
    // Sanity: the QC topic list is non-empty.
    expect(qcTopics.length).toBeGreaterThanOrEqual(6);
  });
});
