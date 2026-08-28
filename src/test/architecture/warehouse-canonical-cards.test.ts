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

/**
 * Composite panels that merely *read* like a card by name. These are not
 * summary-metric tiles: they combine a health headline, a stage sparkline and
 * a CTA, which `SummaryStatCard` deliberately does not model. Adding a file
 * here requires that justification — a plain label+value block never qualifies.
 */
const COMPOSITE_PANELS = new Set([
  "src/features/warehouse/overview/TowerSummaryCard.tsx",
]);

describe("Warehouse canonical card architecture", () => {
  it("has no MetricTile — the deprecated wrapper is deleted, not re-added", () => {
    const offenders = FILES.filter((f) =>
      readFileSync(f, "utf8").includes("MetricTile"),
    );
    expect(offenders).toEqual([]);
  });

  it("declares no Warehouse-local summary card component", () => {
    // Any local declaration — exported or not, `function` or `const` — whose
    // name reads like a stat card is a parallel card system in the making.
    const DECL =
      /(?:export\s+)?(?:function|const|class)\s+\w*(?:Kpi|KPI|Stat|Metric|Summary)\w*(?:Card|Tile)\w*\b/;
    const offenders = FILES.filter((f) => {
      if (COMPOSITE_PANELS.has(f)) return false;
      return DECL.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("renders no bespoke large-metric typography", () => {
    // The canonical card owns metric typography. A warehouse file that sets
    // its own text-2xl/3xl + bold is rendering a stat outside the system.
    const offenders = FILES.filter((f) => {
      const src = readFileSync(f, "utf8");
      return src
        .split("\n")
        .some(
          (line) =>
            /\btext-(?:2xl|3xl)\b/.test(line) &&
            /\bfont-(?:bold|semibold)\b/.test(line),
        );
    });
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

  it("uses the Section primitive for titled sections, never CardTitle", () => {
    // `Section` owns section chrome (title, description, actions, spacing).
    // A raw Card+CardHeader+CardTitle block is a second, drifting section
    // system — the canonical Finance AR/AP workspaces do not use one.
    const offenders = FILES.filter((f) =>
      /\bCardTitle\b/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("resolves status colour through the tone palette, not raw Tailwind", () => {
    // Raw palette classes make re-tinting the ERP a repo-wide edit and let
    // each page invent its own severity scale. `@/design-system` tone helpers
    // (toneText/toneBorder/toneSurface/toneFill/toneRing) are the only source.
    const PALETTE =
      /\b(?:text|bg|border|ring|fill|stroke|from|to|via)-(?:red|orange|amber|yellow|lime|green|emerald|teal|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
    const offenders = FILES.filter((f) => PALETTE.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
