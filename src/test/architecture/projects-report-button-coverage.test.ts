/**
 * Architecture test: every projects portfolio page must surface the unified
 * preview/print engine — either via `RunProjectReportButton` (preferred) or
 * direct `PrintPreviewDialog` import. This protects against regressions where
 * a new page ships without a Run-report button, breaking the Finance/Sales
 * UX consistency principle.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PORTFOLIO_DIR = "src/pages/projects/portfolio";

describe("projects: report-button coverage", () => {
  const files = readdirSync(PORTFOLIO_DIR).filter((f) => f.endsWith(".tsx"));

  it("portfolio dir contains pages", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    // Configuration is settings-style, no report button needed.
    if (f === "Configuration.tsx") continue;
    // Reports.tsx IS the reports hub — it owns its own engine entry.
    if (f === "Reports.tsx") continue;

    it(`${f} imports RunProjectReportButton or PrintPreviewDialog`, () => {
      const src = readFileSync(join(PORTFOLIO_DIR, f), "utf8");
      const ok =
        src.includes("RunProjectReportButton") ||
        src.includes("PrintPreviewDialog");
      expect(ok, `${f} must import RunProjectReportButton or PrintPreviewDialog`).toBe(true);
    });
  }
});
