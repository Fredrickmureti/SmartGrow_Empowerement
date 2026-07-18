/**
 * Architecture guard — ADR 0080 (Warehouse master-data ownership).
 *
 * Enforces the invariants that keep `warehouses` authorship in the
 * Warehouse app and prevents Inventory from silently reclaiming it:
 *
 *   1. No page module for warehouses may live under `src/pages/inventory/**`
 *      or at `src/pages/Warehouses.tsx` — they belong under
 *      `src/pages/warehouse/**`.
 *
 *   2. The Inventory sidebar (`src/apps/inventory/nav.ts`) must NOT
 *      expose a `/inventory-app/warehouses` entry — the sidebar was the
 *      most visible ownership leak and the one operators complained about.
 *
 *   3. The Inventory router (`src/apps/inventory/routes.tsx`) may still
 *      accept legacy `warehouses*` paths for bookmark parity, but every
 *      such <Route> element MUST resolve to a `<Navigate>` — never to a
 *      lazy inventory page component.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

describe("warehouse master-data ownership (ADR 0080)", () => {
  it("no warehouse pages live under src/pages/inventory or at src/pages/Warehouses.tsx", () => {
    const offenders: string[] = [];
    const invDir = path.join(SRC, "pages/inventory");
    if (existsSync(invDir)) {
      for (const f of readdirSync(invDir)) {
        if (/^Warehouse.*\.tsx$/.test(f)) offenders.push(`pages/inventory/${f}`);
      }
    }
    if (existsSync(path.join(SRC, "pages/Warehouses.tsx"))) offenders.push("pages/Warehouses.tsx");
    expect(
      offenders,
      `Warehouse pages must live under src/pages/warehouse/** (ADR 0080):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("inventory sidebar exposes no /inventory-app/warehouses entry", () => {
    const nav = readFileSync(path.join(SRC, "apps/inventory/nav.ts"), "utf8");
    // Strip line/block comments before matching so the ADR reference is safe.
    const stripped = nav
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      /to:\s*["']\/inventory-app\/warehouses/.test(stripped),
      "Inventory nav must not list Warehouses — ownership moved to Warehouse app (ADR 0080).",
    ).toBe(false);
  });

  it("inventory router only redirects legacy warehouses paths — never renders inventory pages", () => {
    const routes = readFileSync(path.join(SRC, "apps/inventory/routes.tsx"), "utf8");
    // Grab every <Route ... path="warehouses..." ... /> and confirm its element is a <Navigate/>.
    const routeMatches = Array.from(
      routes.matchAll(/<Route\b[^>]*\bpath=["']warehouses(?:\/[^"']*)?["'][^>]*element=\{([^}]+)\}[^/]*\/>/g),
    );
    expect(routeMatches.length, "expected at least one legacy warehouses redirect route").toBeGreaterThan(0);
    for (const m of routeMatches) {
      const el = m[1].trim();
      const ok = /^<Navigate\b/.test(el) || /Redirect/.test(el);
      expect(
        ok,
        `Inventory <Route path="warehouses..."> must render <Navigate/> (or a *Redirect wrapper), got: ${el}`,
      ).toBe(true);
    }
  });
});
