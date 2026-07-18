/**
 * Architecture guard: every workspace under `src/apps/<workspace>/` must
 * mount its routes inside `PlatformShell` so the rail + sidebar + topbar
 * chrome stays consistent across the platform.
 *
 * The check is grep-based — it asserts that either the workspace's
 * `routes.tsx` itself imports `PlatformShell`, or it imports a Layout
 * component (the established pattern: `XLayout.tsx` re-exports
 * `PlatformShell` with the workspace's app + nav config).
 *
 * Exceptions are explicit and explained — never grow this list without
 * an architectural reason that lands in `docs/design-system.md`.
 *
 * Sub-apps (`src/apps/hr/sub/*Routes.tsx`) are checked the same way
 * since the HR domain is split into independently installable apps that
 * each own their own shell.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";

const APPS_ROOT = resolve(__dirname, "../../../src/apps");

/**
 * Workspaces that legitimately do not render through `PlatformShell`.
 * Each entry must carry a one-line reason; reviewers should reject any
 * addition without an architectural justification.
 */
const EXEMPT_WORKSPACES = new Map<string, string>([
  // POS terminal owns its own immersive cashier chrome (full-screen,
  // no rail / no sidebar) — see `POSShellLayout.tsx`.
  ["pos", "POS terminal owns immersive cashier chrome via POSShellLayout"],
  // `me` (employee self-service portal), `platform` (super-admin),
  // `sms`, `studio` route into purpose-built shells distinct from the
  // workspace shell. Tracked for review during their respective
  // foundation passes — do not extend this list without an ADR.
  ["me", "Employee self-service portal uses MePortalLayout"],
  ["platform", "Super-admin console uses PlatformAdminLayout"],
  ["sms", "SMS console uses SmsConsoleLayout"],
  ["studio", "Internal studio tooling uses StudioLayout"],
  // RF/mobile operator shell — full-screen touch-first chrome via
  // MobileWarehouseLayout (see ADR referenced in wms-phase13 guard).
  ["warehouse-mobile", "RF/mobile operator app uses MobileWarehouseLayout"],
]);

function listDirs(root: string): string[] {
  return readdirSync(root).filter((entry) => {
    const full = join(root, entry);
    return statSync(full).isDirectory();
  });
}

function shellMounts(filePath: string): boolean {
  const text = readFileSync(filePath, "utf-8");
  if (/\bPlatformShell\b/.test(text)) return true;
  // Established pattern: routes.tsx imports `XLayout` which mounts
  // PlatformShell. Walk one hop and re-check.
  const layoutImport = text.match(
    /import\s+\{\s*([A-Za-z0-9_]*Layout)\s*\}\s+from\s+["']\.\/(\1)["']/,
  );
  if (!layoutImport) return false;
  const layoutFile = join(dirname(filePath), `${layoutImport[2]}.tsx`);
  if (!existsSync(layoutFile)) return false;
  return /\bPlatformShell\b/.test(readFileSync(layoutFile, "utf-8"));
}

describe("Workspace shell: every app routes through PlatformShell", () => {
  const offenders: string[] = [];
  const checked: string[] = [];

  for (const workspace of listDirs(APPS_ROOT)) {
    const routesFile = join(APPS_ROOT, workspace, "routes.tsx");
    if (!existsSync(routesFile)) continue;
    checked.push(workspace);
    if (EXEMPT_WORKSPACES.has(workspace)) continue;
    if (!shellMounts(routesFile)) {
      offenders.push(`src/apps/${workspace}/routes.tsx`);
    }
  }

  // HR sub-apps each own their own shell.
  const hrSub = join(APPS_ROOT, "hr", "sub");
  if (existsSync(hrSub)) {
    for (const f of readdirSync(hrSub).filter((f) => f.endsWith("Routes.tsx"))) {
      const file = join(hrSub, f);
      checked.push(`hr/sub/${basename(f)}`);
      const text = readFileSync(file, "utf-8");
      if (!/\bPlatformShell\b/.test(text)) {
        offenders.push(`src/apps/hr/sub/${f}`);
      }
    }
  }

  it("at least one workspace was inspected (smoke)", () => {
    expect(checked.length).toBeGreaterThan(0);
  });

  it("workspace routes are wrapped in PlatformShell (or an exempt shell)", () => {
    expect(
      offenders,
      "These workspace route files do not render through PlatformShell. " +
        "See docs/design-system.md — every authenticated workspace must " +
        "inherit the unified rail+sidebar+topbar chrome via PlatformShell. " +
        "Offenders:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
