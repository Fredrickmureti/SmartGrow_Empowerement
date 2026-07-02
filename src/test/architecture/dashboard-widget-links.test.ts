/**
 * Architectural guard: dashboard widget navigate() targets must point at
 * real registered routes, not legacy short paths. The previous agent left
 * four widgets pointing at `/inventory`, `/banking`, `/invoices` which
 * 404. This test parses each widget for hard-coded navigate paths and
 * asserts the path prefix is one of the registered module roots in
 * `src/App.tsx`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WIDGETS = [
  "src/components/dashboard/BankBalanceWidget.tsx",
  "src/components/dashboard/BackorderWidget.tsx",
  "src/components/dashboard/LowStockWidget.tsx",
  "src/components/dashboard/ReceivablesWidget.tsx",
  "src/components/dashboard/UpcomingDeadlinesWidget.tsx",
  "src/components/dashboard/PayrollSummaryWidget.tsx",
  "src/components/dashboard/DashboardSetupGuide.tsx",
];

// Registered top-level module paths in src/App.tsx — anything else is
// a legacy short path that 404s in production.
const VALID_PREFIXES = [
  "/dashboard",
  "/home",
  "/finance",
  "/sales",
  "/purchases",
  "/inventory-app",
  "/contacts-app",
  "/hr",
  "/crm-app",
  "/pos",
  "/reports",
  "/settings",
  "/onboarding",
  "/admin",
  "/platform",
  "/kiosk",
];

// Known-broken short paths that previously shipped — explicit reject list
// so a regression produces a meaningful failure message.
const BANNED = ["/inventory", "/banking", "/invoices", "/contacts", "/expenses"];

const NAV_RE = /navigate\(\s*["'`]([^"'`]+)["'`]/g;

describe("dashboard widget links", () => {
  for (const widget of WIDGETS) {
    it(`${widget} only navigates to registered routes`, () => {
      const src = readFileSync(join(process.cwd(), widget), "utf8");
      const targets: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = NAV_RE.exec(src)) !== null) {
        // Strip template-literal interpolations so `/x?y=${id}` becomes "/x?y=".
        targets.push(m[1].split("?")[0].split("#")[0]);
      }
      for (const t of targets) {
        expect(
          BANNED.includes(t),
          `${widget} navigates to banned legacy path "${t}". Use the full module path (e.g. /finance/banking, /sales/invoices, /inventory-app/stock).`,
        ).toBe(false);
        const ok = VALID_PREFIXES.some((p) => t === p || t.startsWith(p + "/"));
        expect(
          ok,
          `${widget} navigates to "${t}" which does not match any registered route prefix in src/App.tsx`,
        ).toBe(true);
      }
    });
  }
});