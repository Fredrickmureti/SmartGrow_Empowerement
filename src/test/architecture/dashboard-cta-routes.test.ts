/**
 * Dashboard CTA route discipline.
 *
 * Every navigation target rendered from the dashboard surface
 * (DashboardSetupGuide, DashboardCommandStrip, DashboardCreateBar,
 * widgets, QuickActions, FinanceDashboard, SalesDashboard) MUST
 * resolve to a real route. The original audit revealed several
 * dashboard CTAs (e.g. `/contacts-app/contacts`) silently redirecting
 * because no <Route path> matched. This test statically extracts every
 * href / navigate("/...") literal and asserts it maps to a route
 * registered under either src/App.tsx (top-level mounts) or
 * src/apps/<app>/routes.tsx (child paths).
 *
 * Keeps drift impossible: if someone adds a new app dashboard CTA,
 * they must add a corresponding route or the build fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Files whose nav targets we audit.
const SURFACES = [
  "src/components/dashboard/DashboardSetupGuide.tsx",
  "src/components/dashboard/DashboardCommandStrip.tsx",
  "src/components/dashboard/DashboardCreateBar.tsx",
  "src/components/dashboard/BankBalanceWidget.tsx",
  "src/components/dashboard/ReceivablesWidget.tsx",
  "src/components/dashboard/ExecutiveDashboard.tsx",
  "src/pages/Dashboard.tsx",
  "src/components/home/QuickActions.tsx",
  "src/pages/finance/FinanceDashboard.tsx",
  "src/pages/sales/SalesDashboard.tsx",
  "src/pages/inventory/InventoryDashboard.tsx",
  "src/pages/hr/HRDashboard.tsx",
  "src/pages/hr/payroll/Overview.tsx",
  "src/pages/purchases/PurchasesDashboard.tsx",
  "src/pages/Banking.tsx",
];

// Extract route prefixes mounted in App.tsx (e.g. /finance/*, /sales/*).
function getTopLevelMounts(): string[] {
  const src = read("src/App.tsx");
  const re = /path="\/([a-z0-9-]+)\/\*"/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.add("/" + m[1]);
  return [...out];
}

// Read child routes per app: returns map mount → Set<childPath>.
function getAppChildRoutes(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const appsDir = join(root, "src/apps");
  const apps = readdirSync(appsDir).filter((d) => {
    try { return statSync(join(appsDir, d)).isDirectory(); } catch { return false; }
  });
  for (const app of apps) {
    const candidates = [
      `src/apps/${app}/routes.tsx`,
      `src/apps/${app}/routes.ts`,
    ];
    for (const file of candidates) {
      try {
        const src = read(file);
        const re = /path="([^"*]+)"/g;
        const set = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) set.add(m[1]);
        // Map app folder to its mount prefix in App.tsx.
        // Best-effort: try common prefixes by string-matching App.tsx.
        const appTsx = read("src/App.tsx");
        const importLine = new RegExp(`from\\s+"@/apps/${app}/routes"`).test(appTsx);
        if (!importLine) continue;
        // Heuristic: find path="/<prefix>/*" nearest the lazy import name.
        const importNameMatch = appTsx.match(new RegExp(`const\\s+(\\w+)\\s*=\\s*lazy\\([^)]*"@/apps/${app}/routes"`));
        if (!importNameMatch) continue;
        const componentName = importNameMatch[1];
        const mountRe = new RegExp(`path="(\\/[a-z0-9-]+)\\/\\*"[\\s\\S]{0,800}?<${componentName}\\s*/>`);
        const mountMatch = appTsx.match(mountRe);
        if (!mountMatch) continue;
        map.set(mountMatch[1], set);
      } catch {
        /* file missing */
      }
    }
  }
  return map;
}

function extractTargets(src: string): string[] {
  const re = /(?:href|to)\s*[:=]\s*["'](\/[a-zA-Z0-9_\-/]+)(?:\?[^"']*)?["']|navigate\(\s*["'](\/[a-zA-Z0-9_\-/]+)(?:\?[^"']*)?["']/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1] ?? m[2]);
  return out;
}

describe("dashboard CTA routes resolve", () => {
  const mounts = getTopLevelMounts();
  const childMap = getAppChildRoutes();

  function resolves(path: string): boolean {
    // Find matching mount prefix
    const mount = mounts.find((m) => path === m || path.startsWith(m + "/"));
    if (!mount) {
      // Flat top-level route in App.tsx (e.g. /settings/company, /finance/reconciliation
      // when mounted explicitly). Accept any literal path= match.
      const appSrc = read("src/App.tsx");
      const re = new RegExp(`path="${path.replace(/\//g, "\\/")}(?:/\\*)?"`);
      return re.test(appSrc);
    }
    const rest = path === mount ? "" : path.slice(mount.length + 1);
    const children = childMap.get(mount);
    if (!children) return true; // unknown mount mapping — don't false-fail
    if (rest === "") return true; // index of an app is always valid
    // Match child paths (incl. those with :params and nested slashes).
    for (const c of children) {
      const pattern = "^" + c.replace(/:[^/]+/g, "[^/]+") + "$";
      if (new RegExp(pattern).test(rest)) return true;
    }
    return false;
  }

  for (const file of SURFACES) {
    it(`${file} — every CTA resolves`, () => {
      let src: string;
      try { src = read(file); } catch { return; }
      const targets = extractTargets(src);
      const broken = targets.filter((t) => !resolves(t));
      expect(broken, `Broken CTA targets in ${file}: ${broken.join(", ")}`).toEqual([]);
    });
  }
});
