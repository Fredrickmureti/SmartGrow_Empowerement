/**
 * Warehouse card architecture.
 *
 * The ERP has exactly one summary-metric card: `SummaryStatCard` /
 * `SummaryStatGrid` (`src/components/common/SummaryStatCards.tsx`, re-exported
 * from `@/design-system`), the same primitive Finance AR/AP uses. Warehouse
 * must not fork it, wrap it, or hand-roll a parallel metric tile — a second
 * card is how the two workspaces drift apart visually and behaviourally.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/pages/warehouse", "src/features/warehouse"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap(walk);

describe("Warehouse canonical card architecture", () => {
  it("has no MetricTile — the deprecated wrapper is deleted, not re-added", () => {
    const offenders = FILES.filter((f) =>
      readFileSync(f, "utf8").includes("MetricTile"),
    );
    expect(offenders).toEqual([]);
  });

  it("declares no Warehouse-local summary card component", () => {
    const offenders = FILES.filter((f) =>
      /export function (Metric|Stat|Kpi|KPI)(Tile|Card)\b/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("imports the canonical card from the shared surfaces only", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      const imports = src.match(/import[^;]*SummaryStat[^;]*;/g) ?? [];
      if (imports.length === 0) continue;
      const ok = imports.every(
        (line) =>
          line.includes('from "@/design-system"') ||
          line.includes('from "@/components/common/SummaryStatCards"') ||
          /from "\.[^"]*"/.test(line),
      );
      if (!ok) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
