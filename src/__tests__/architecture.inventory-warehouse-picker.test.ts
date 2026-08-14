/**
 * Architecture guard — inventory surfaces must never offer an in-transit
 * warehouse in an operational picker.
 *
 * `warehouses` holds a per-business "In-Transit" pseudo-warehouse: a
 * bookkeeping bucket for stock dispatched but not yet received. It cannot be
 * counted, adjusted, scrapped or picked. The shared `useWarehouses` hook
 * excludes it; pages that hand-roll their own query kept forgetting to, which
 * is how the Cycle Count schedule picker ended up listing it.
 *
 * Rule: an inventory page either consumes `useWarehouses`, or — if it queries
 * the table directly — filters `is_in_transit` out.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/pages/inventory"];
const EXTRA_FILES = ["src/pages/Inventory.tsx"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = [
  ...ROOTS.flatMap((r) => walk(join(process.cwd(), r))),
  ...EXTRA_FILES.map((f) => join(process.cwd(), f)),
];

describe("inventory warehouse pickers", () => {
  it("never lists in-transit warehouses", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes('from("warehouses")')) continue;
      if (!src.includes("is_in_transit")) offenders.push(file);
    }
    expect(
      offenders,
      `These inventory files query warehouses without excluding in-transit buckets. ` +
        `Use the useWarehouses hook, or add ` +
        `.or("is_in_transit.is.null,is_in_transit.eq.false").`,
    ).toEqual([]);
  });
});
