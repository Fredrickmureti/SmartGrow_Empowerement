/**
 * Architecture guard — the Reports navigation is registry-driven.
 *
 * The Finance sidebar used to carry a hand-written list of report links. It
 * drifted from `REPORT_REGISTRY`: FX Revaluation, FX Exposure, Bank
 * reconciliation, the integrity reconciliations and the stock reports were
 * registered and routed but unreachable from the sidebar.
 *
 * These tests fail if:
 *  - a finance report exists in the registry but is not reachable from the nav;
 *  - a report is claimed by more than one family (duplicate / same-family
 *    reports appearing at the same level);
 *  - a nav link points at a path no registry entry declares;
 *  - a nav file re-introduces hardcoded `/finance/reports/...` links.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPORT_REGISTRY } from "@/services/reports/ReportRegistry";
import {
  REPORT_FAMILIES,
  buildReportsNavChildren,
  collectNavReportPaths,
  getFinanceReportDefinitions,
} from "@/services/reports/reportsNav";

const navPaths = collectNavReportPaths(buildReportsNavChildren());

describe("Reports navigation is derived from the report registry", () => {
  it("every finance report in the registry is reachable from the nav", () => {
    const missing = getFinanceReportDefinitions()
      .filter((r) => !navPaths.includes(r.path))
      .map((r) => `${r.id} (${r.path})`);
    expect(missing).toEqual([]);
  });

  it("no report is claimed by two families", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const family of REPORT_FAMILIES) {
      for (const id of family.reportIds) {
        if (seen.has(id)) dupes.push(`${id}: ${seen.get(id)} + ${family.key}`);
        seen.set(id, family.key);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("no family references an unknown report id", () => {
    const ids = new Set(REPORT_REGISTRY.map((r) => r.id));
    const unknown = REPORT_FAMILIES.flatMap((f) =>
      f.reportIds.filter((id) => !ids.has(id)).map((id) => `${f.key}:${id}`),
    );
    expect(unknown).toEqual([]);
  });

  it("every nav link resolves to a registered report path", () => {
    const known = new Set(REPORT_REGISTRY.map((r) => r.path));
    expect(navPaths.filter((p) => !known.has(p))).toEqual([]);
  });

  it("nav files do not hardcode report links", () => {
    for (const file of ["src/apps/finance/nav.ts", "src/apps/reports/nav.ts"]) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      const hardcoded = [...src.matchAll(/to:\s*"(\/(?:finance\/)?reports\/[^"]+)"/g)].map(
        (m) => `${file} → ${m[1]}`,
      );
      expect(hardcoded).toEqual([]);
    }
  });
});
