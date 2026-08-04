/**
 * nav-app-coherence.test.ts — guards ADR 0101.
 *
 * Invariant: **navigation replacement is permitted only when crossing an
 * `AppDefinition`.** Within one app, navigation expands via
 * `WorkspaceNavItem.children`; it never swaps the sidebar out.
 *
 * Concretely, for every `<PlatformShell app={X} nav={Y}>` mount in the
 * codebase, a given `X` must always be paired with the same `Y`. This is
 * the invariant whose absence let the Employees workspace drift into
 * seven competing sidebars (Contracts / Lifecycle / Reports /
 * Document compliance / Recruitment each replaced the Employees nav while
 * remaining the Employees app).
 *
 * A second check closes the companion hole: every `/hr/*` route subtree
 * that mounts `EMPLOYEES_APP` must be reachable from `EMPLOYEES_NAV`, so
 * no surface can be routable-but-invisible again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { EMPLOYEES_NAV } from "@/apps/hr/shared/navs";

const ROOT = resolve(__dirname, "../../..");
const APPS_ROOT = join(ROOT, "src/apps");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

interface Mount {
  file: string;
  app: string;
  nav: string;
}

function collectMounts(): Mount[] {
  const mounts: Mount[] = [];
  for (const file of walk(APPS_ROOT)) {
    const text = readFileSync(file, "utf8");
    // Match `<PlatformShell ... app={X} ... nav={Y}` in either order.
    const re = /<PlatformShell\b([^>]*)>/gs;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const attrs = m[1];
      const app = attrs.match(/\bapp=\{([A-Za-z0-9_]+)\}/)?.[1];
      const nav = attrs.match(/\bnav=\{([A-Za-z0-9_]+)\}/)?.[1];
      if (app && nav) {
        mounts.push({ file: relative(ROOT, file), app, nav });
      }
    }
  }
  return mounts;
}

describe("ADR 0101 — nav/app coherence", () => {
  it("finds PlatformShell mounts to check", () => {
    expect(collectMounts().length).toBeGreaterThan(5);
  });

  it("each AppDefinition is paired with exactly one WorkspaceNav", () => {
    const byApp = new Map<string, Map<string, string[]>>();
    for (const { file, app, nav } of collectMounts()) {
      const navs = byApp.get(app) ?? new Map<string, string[]>();
      navs.set(nav, [...(navs.get(nav) ?? []), file]);
      byApp.set(app, navs);
    }

    const offenders: string[] = [];
    for (const [app, navs] of byApp) {
      if (navs.size > 1) {
        const detail = [...navs.entries()]
          .map(([nav, files]) => `${nav} (${files.join(", ")})`)
          .join(" vs ");
        offenders.push(`${app} is mounted with ${navs.size} different navs: ${detail}`);
      }
    }

    expect(
      offenders,
      [
        "Navigation replacement is only allowed when crossing an AppDefinition.",
        "Fold the extra surfaces into the app's single WorkspaceNav as",
        "collapsible `children` instead of passing a different `nav`.",
        ...offenders,
      ].join("\n"),
    ).toEqual([]);
  });

  it("every EMPLOYEES_APP route subtree is reachable from EMPLOYEES_NAV", () => {
    const navSource = readFileSync(join(ROOT, "src/apps/hr/shared/navs.ts"), "utf8");
    const employeesNav = navSource.slice(navSource.indexOf("export const EMPLOYEES_NAV"));
    // EMPLOYEES_NAV folds in the surface navs via flattenNavItems(), so a
    // surface counts as reachable when either a literal link or its nav is
    // referenced from the Employees nav.
    const reachable = (prefix: string, navConst: string) =>
      employeesNav.includes(prefix) || employeesNav.includes(navConst);

    const surfaces: [string, string][] = [
      ["/hr/contracts", "CONTRACTS_NAV"],
      ["/hr/lifecycle", "LIFECYCLE_NAV"],
      ["/hr/reports", "HR_REPORTS_NAV"],
      ["/hr/document-compliance", "DOCUMENT_COMPLIANCE_NAV"],
      ["/hr/recruitment", "RECRUITMENT_NAV"],
    ];

    const orphans = surfaces
      .filter(([prefix, navConst]) => !reachable(prefix, navConst))
      .map(([prefix]) => prefix);

    expect(orphans, `Unreachable Employees surfaces: ${orphans.join(", ")}`).toEqual([]);
  });

  it("EMPLOYEES_NAV folds the surfaces in as children at runtime", () => {
    const flat = EMPLOYEES_NAV.groups.flatMap((g) => g.items);
    const parents = ["Contracts & letters", "Lifecycle events", "HR reports", "Document compliance"];
    for (const label of parents) {
      const item = flat.find((i) => i.label === label);
      expect(item, label).toBeDefined();
      expect(item!.children?.length ?? 0, label).toBeGreaterThan(0);
    }
    expect(flat.map((i) => i.label)).toContain("Directory");
    expect(flat.map((i) => i.label)).toContain("Recruitment & offers");
  });

  it("the retired ORG_NAV is gone", () => {
    const navSource = readFileSync(join(ROOT, "src/apps/hr/shared/navs.ts"), "utf8");
    expect(navSource).not.toMatch(/export const ORG_NAV/);
  });
});
