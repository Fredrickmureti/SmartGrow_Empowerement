/**
 * Phase 2.6 guard — one canonical WMS event vocabulary.
 *
 * 1. Every topic in WMS_TOPIC is documented in WMS_MODULE_OWNERSHIP.md.
 * 2. The retired legacy vocabulary never reappears in runtime code.
 * 3. domainEventBus does not re-declare warehouse topics (it imports WmsTopic).
 * 4. Saga registration is catalog-driven, not hand-maintained.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WMS_TOPIC } from "@/features/warehouse/events/topics";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const DOC = "docs/architecture/WMS_MODULE_OWNERSHIP.md";

/** Topics retired by the Phase 2.6 vocabulary unification. */
const RETIRED_TOPICS = [
  "warehouse.qc.opened",
  "warehouse.qc.accepted",
  "warehouse.qc.rejected",
  "warehouse.yard.checked_in",
  "warehouse.yard.docked",
  "warehouse.yard.departed",
  "warehouse.count.opened",
  "warehouse.manifest.opened",
  "warehouse.pick.completed",
  "warehouse.pack.completed",
  "warehouse.putaway.completed",
  "warehouse.putaway.suggested",
  "warehouse.grn.received",
  "warehouse.shipment.dispatched",
  "warehouse.cycle_count.variance",
];

describe("WMS event vocabulary is unified", () => {
  it("documents every canonical topic in the ownership register", () => {
    const doc = read(DOC);
    const missing = Object.values(WMS_TOPIC).filter(
      (topic) => !doc.includes(`\`${topic}\``),
    );
    expect(missing).toEqual([]);
  });

  it("has no duplicate topic values", () => {
    const values = Object.values(WMS_TOPIC);
    expect(new Set(values).size).toBe(values.length);
  });

  it("never reintroduces the retired legacy topics in runtime code", async () => {
    const { globSync } = await import("glob");
    const files = globSync("src/**/*.{ts,tsx}", {
      cwd: root,
      ignore: ["src/test/**", "src/**/*.test.ts", "src/**/*.test.tsx"],
    });
    const offenders: string[] = [];
    for (const file of files) {
      const src = read(file);
      for (const topic of RETIRED_TOPICS) {
        if (src.includes(topic)) offenders.push(`${file} -> ${topic}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps domainEventBus free of hand-written warehouse topics", () => {
    const src = read("src/services/events/domainEventBus.ts");
    expect(src).toContain("WmsTopic");
    expect(src).not.toMatch(/'warehouse\.[a-z_.]+'/);
  });

  it("registers saga consumers straight off the catalog", () => {
    const src = read("src/components/events/BusinessSagaMount.tsx");
    expect(src).toMatch(/for \(const topic of Object\.values\(WMS_TOPIC\)\)/);
    expect(src).not.toMatch(/saga\.register\('warehouse\./);
  });
});
