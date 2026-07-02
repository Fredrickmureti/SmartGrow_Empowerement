/**
 * Phase A — IA convergence guard.
 *
 * Enforces the invariants the HR Workspace audit (.lovable/plan.md §2)
 * called out as recurring drift:
 *
 *   1. EMPLOYEES_NAV must not link to the pre-consolidation URLs that
 *      now belong to other workspaces (Org / Talent / Time Off / HR
 *      Reports). Cross-workspace nav items leave Employees, which is
 *      the ping-pong regression the audit flagged.
 *
 *   2. `src/apps/hr/routes.tsx` must consume `HR_REDIRECTS` and emit
 *      its redirects from that map. Hand-listed inline <Navigate />
 *      elements for paths already in the map are dual-maintenance.
 *
 *   3. `src/apps/timesheets/*` must not import from `src/apps/hr/*`.
 *      Timesheets is its own installable app; cross-app coupling
 *      breaks the "independently installable" contract from ADR 0005.
 *
 *   4. The registry must define ORG_APP and CONTRACTS_APP as distinct
 *      apps with distinct basePaths from EMPLOYEES_APP — the prior
 *      half-state where Org/Contracts borrowed EMPLOYEES_APP identity
 *      is what the Wave-1 split was supposed to end.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  EMPLOYEES_APP,
  ORG_APP,
  CONTRACTS_APP,
} from "@/lib/apps/registry";
import { EMPLOYEES_NAV } from "@/apps/hr/shared/navs";
import { HR_REDIRECTS } from "@/apps/hr/shared/redirects";

const repo = process.cwd();
const read = (p: string) => readFileSync(join(repo, p), "utf8");

function collectPaths(nav: typeof EMPLOYEES_NAV): string[] {
  const out: string[] = [];
  for (const group of nav.groups) {
    for (const item of group.items) {
      out.push(item.to);
      if ("children" in item && Array.isArray((item as { children?: unknown }).children)) {
        for (const child of (item as { children: { to: string }[] }).children) {
          out.push(child.to);
        }
      }
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe("Phase A — HR IA convergence", () => {
  it("EMPLOYEES_NAV does not link to URLs now owned by other workspaces", () => {
    const forbidden = [
      "/hr/departments",
      "/hr/job-positions",
      "/hr/work-locations",
      "/hr/org-chart",
      "/hr/performance",
      "/hr/configuration/competencies",
      "/hr/configuration/public-holidays",
      "/hr/reports",
    ];
    const paths = collectPaths(EMPLOYEES_NAV);
    const violations = paths.filter((p) => forbidden.includes(p));
    expect(
      violations,
      `EMPLOYEES_NAV must not link cross-workspace paths: ${violations.join(", ")}`,
    ).toEqual([]);
  });

  it("routes.tsx consumes HR_REDIRECTS — no inline <Navigate /> for mapped paths", () => {
    const src = read("src/apps/hr/routes.tsx");
    expect(src).toMatch(/HR_REDIRECTS/);
    // Every HR_REDIRECTS target should be referenced via the map iteration,
    // not as a literal <Navigate to="..."> for a mapped destination.
    for (const [from, to] of Object.entries(HR_REDIRECTS)) {
      const literalRoute = new RegExp(
        `<Route\\s+path="${from.replace("/hr/", "")}"\\s+element={<Navigate\\s+to="${to.replace(/[/$.]/g, "\\$&")}"`,
      );
      expect(
        literalRoute.test(src),
        `Inline <Navigate> for "${from}" → "${to}" found; redirects must flow through HR_REDIRECTS`,
      ).toBe(false);
    }
  });

  it("apps/timesheets does not import from apps/hr", () => {
    const files = walk(join(repo, "src/apps/timesheets"));
    const offenders: string[] = [];
    const re = /from\s+["']@\/apps\/hr\/[^"']+["']/;
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      if (re.test(content)) offenders.push(f);
    }
    expect(
      offenders,
      `apps/timesheets must not import from apps/hr (use apps/timesheets/nav.ts instead):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("Wave-1 workspaces have distinct app identities", () => {
    expect(EMPLOYEES_APP.id).toBe("employees");
    expect(ORG_APP.id).toBe("org");
    expect(CONTRACTS_APP.id).toBe("contracts");

    const basePaths = [EMPLOYEES_APP.basePath, ORG_APP.basePath, CONTRACTS_APP.basePath];
    expect(new Set(basePaths).size).toBe(basePaths.length);
  });
});
