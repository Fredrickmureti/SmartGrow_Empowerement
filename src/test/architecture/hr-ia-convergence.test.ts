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
 *   2. There is no HR redirect/alias layer. Every surface has exactly
 *      one canonical URL and all links point at it directly.
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

  it("no HR redirect/alias layer — every surface has exactly one URL", () => {
    const files = walk(join(repo, "src/apps/hr")).concat(walk(join(repo, "src/pages/hr")));
    const dead = [
      "/hr/departments",
      "/hr/job-positions",
      "/hr/work-locations",
      "/hr/org-chart",
      "/hr/org/",
      "/hr/performance",
      "/hr/settings",
      "/hr/my-portal",
      "/hr/my-profile",
      "/hr/employee-contracts",
      "/hr/employees/reports",
      "/hr/configuration/competencies",
      "/hr/configuration/public-holidays",
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      for (const d of dead) {
        if (content.includes(`"${d}"`)) offenders.push(`${f}: ${d}`);
      }
    }
    expect(
      offenders,
      `Dead HR URLs must not be linked or routed:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the HR redirect map is gone", () => {
    expect(() => read("src/apps/hr/shared/redirects.ts")).toThrow();
    expect(read("src/apps/hr/routes.tsx")).not.toMatch(/HR_REDIRECTS/);
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
