/**
 * HR Configuration architecture invariants
 *
 * - No new code may navigate to `/hr/settings?tab=...` — those query
 *   parameters are dropped by the legacy redirect. Use the dedicated
 *   sub-routes under `/hr/configuration/*` instead.
 * - The Configuration shell must mount nested routes for the new pages.
 * - Maintenance bulk-link must go through the `get_linkable_users_for_employee`
 *   RPC, not direct profiles / user_roles reads.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(p);
    }
  }
  return acc;
}

describe("HR Configuration architecture", () => {
  const files = walk(SRC);

  it("no source uses the legacy /hr/settings?tab= deep link", () => {
    const offenders = files.filter((f) => {
      // The redirect resolver + this test itself are allowed to reference it.
      if (f.endsWith("apps/hr/sub/EmployeesRoutes.tsx")) return false;
      if (f.endsWith("hr-configuration-shell.test.ts")) return false;
      const src = readFileSync(f, "utf8");
      return /\/hr\/settings\?tab=/.test(src);
    });
    expect(offenders, `Use /hr/configuration/<section> instead:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("Configuration shell registers the four critical sub-routes", () => {
    const shell = readFileSync(
      join(SRC, "pages/hr/configuration/ConfigurationLayout.tsx"),
      "utf8",
    );
    for (const route of [
      "onboarding-templates",
      "statutory-fields",
      "policies",
      "maintenance",
    ]) {
      expect(shell.includes(route), `Missing route: ${route}`).toBe(true);
    }
  });

  it("Maintenance bulk-link uses the get_linkable_users_for_employee RPC", () => {
    const src = readFileSync(
      join(SRC, "pages/hr/configuration/MaintenancePage.tsx"),
      "utf8",
    );
    expect(src.includes("get_linkable_users_for_employee")).toBe(true);
    expect(src.includes('.from("profiles")'), "no direct profiles read").toBe(false);
    expect(src.includes('.from("user_roles")'), "no direct user_roles read").toBe(false);
  });

  it("Legacy HRSettings and EmployeesConfiguration pages are removed", () => {
    const offenders = files.filter((f) =>
      f.endsWith("pages/hr/HRSettings.tsx") ||
      f.endsWith("pages/hr/EmployeesConfiguration.tsx"),
    );
    expect(offenders, `Legacy files still present:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("Configuration pages use ConfigPageHeader, not bespoke SectionHeader or hardcoded micro-font sizes (Wave J typography)", () => {
    const configDir = join(SRC, "pages/hr/configuration");
    const configFiles = walk(configDir);
    const offenders: { file: string; reason: string }[] = [];
    for (const f of configFiles) {
      if (f.endsWith("_ConfigShell.tsx")) continue;
      const src = readFileSync(f, "utf8");
      if (/\bSectionHeader\b/.test(src)) {
        offenders.push({ file: f, reason: "uses deprecated SectionHeader — import ConfigPageHeader from ./_ConfigShell" });
      }
      if (/text-\[1[01]px\]/.test(src)) {
        offenders.push({ file: f, reason: "hardcoded text-[10px]/text-[11px] — use text-xs" });
      }
    }
    expect(
      offenders,
      `Typography violations:\n${offenders.map((o) => `  ${o.file} — ${o.reason}`).join("\n")}`,
    ).toEqual([]);
  });
});
