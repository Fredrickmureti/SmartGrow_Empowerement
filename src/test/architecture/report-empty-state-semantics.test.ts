/**
 * Phase 9 guard — a report screen may never render silence.
 *
 * Four states must stay distinguishable on a report surface:
 *   no_data | missing_prerequisite | failed | missing_presentation
 *
 * `missing_presentation` (rows present, columns absent) is the state that
 * hid the Branch Payroll Cost defect: the grid rendered zero headers over
 * a real row and read as "no data". It must surface as a defect banner,
 * never as an empty period.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const emptyStateSrc = readFileSync(
  resolve(root, "components/reports/ReportEmptyState.tsx"),
  "utf8",
);
const layoutSrc = readFileSync(
  resolve(root, "components/reports/ReportPageLayout.tsx"),
  "utf8",
);
const viewerSrc = readFileSync(
  resolve(root, "pages/hr/payroll/reports/PayrollReportViewer.tsx"),
  "utf8",
);

describe("report empty-state semantics", () => {
  it("models all four empty-state kinds in one place", () => {
    for (const kind of [
      "no_data",
      "missing_prerequisite",
      "failed",
      "missing_presentation",
    ]) {
      expect(emptyStateSrc).toContain(`${kind}:`);
    }
  });

  it("gives every kind its own copy rather than a shared generic message", () => {
    const titles = [...emptyStateSrc.matchAll(/title:\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(titles.length).toBeGreaterThanOrEqual(4);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("lets the page layout render a typed empty state", () => {
    expect(layoutSrc).toContain("emptyState?: ReportEmptyStateDescriptor");
    expect(layoutSrc).toContain("<ReportEmptyState descriptor={emptyState} />");
  });

  it("treats rows-without-columns as a defect in the payroll viewer", () => {
    expect(viewerSrc).toContain('kind: "missing_presentation"');
    // The condition must be rows present AND columns absent — not either/or.
    expect(viewerSrc).toMatch(/rows\.length\s*>\s*0\s*&&\s*columns\.length\s*===\s*0/);
  });

  it("distinguishes a pending upstream dependency from a genuinely empty period", () => {
    expect(viewerSrc).toContain('kind: "missing_prerequisite"');
    expect(viewerSrc).toContain('kind: "no_data"');
    expect(viewerSrc).toContain("pendingDependencies");
  });

  it("routes the missing-presentation case into the empty branch so it cannot render a headerless grid", () => {
    expect(viewerSrc).toMatch(/rows\.length === 0 \|\| columns\.length === 0/);
  });
});
