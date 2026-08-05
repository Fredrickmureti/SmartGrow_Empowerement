/**
 * warehouse-nav-ia.test.ts — guards ADR 0102 (Warehouse information
 * architecture).
 *
 * The Warehouse sidebar previously grew into a flat 29-item list because
 * nothing stopped a new page from appending one more top-level row. These
 * tests make the domain structure a build-time invariant:
 *
 * 1. No orphan pages — every routable warehouse surface is reachable from
 *    `WAREHOUSE_NAV` (directly or as the parent of a sub-route).
 * 2. No dead links — every nav `to:` corresponds to a declared route.
 * 3. No flat-sidebar regression — depth <= 2 and <= 8 items per group.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WAREHOUSE_NAV } from "@/apps/warehouse/nav";
import type { WorkspaceNavItem } from "@/components/layout/shell/types";

const ROOT = resolve(__dirname, "../../..");
const PREFIX = "/warehouse-app/";

const routesSource = readFileSync(
  join(ROOT, "src/apps/warehouse/routes.tsx"),
  "utf8",
);

/** Every `path="..."` declared in the warehouse route tree. */
function declaredRoutes(): string[] {
  const out = new Set<string>();
  const re = /path="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(routesSource))) out.add(m[1]);
  out.delete("*");
  return [...out];
}

/** Route paths that represent a navigable *surface*, not a detail/redirect. */
function surfaceRoutes(): string[] {
  return declaredRoutes().filter((p) => {
    if (p.includes(":")) return false; // detail views, reached from a list
    // `<Route path="x" element={<Navigate .../>} />` — legacy redirects.
    const isRedirect = new RegExp(
      `path="${p.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}"[^>]*<Navigate`,
    ).test(routesSource);
    return !isRedirect;
  });
}

function flatten(items: WorkspaceNavItem[]): WorkspaceNavItem[] {
  return items.flatMap((i) => [i, ...flatten(i.children ?? [])]);
}

const navItems = flatten(WAREHOUSE_NAV.groups.flatMap((g) => g.items));
const navPaths = navItems.map((i) => i.to.replace(PREFIX, ""));

function depthOf(item: WorkspaceNavItem, depth = 1): number {
  if (!item.children?.length) return depth;
  return Math.max(...item.children.map((c) => depthOf(c, depth + 1)));
}

describe("ADR 0102 — warehouse navigation IA", () => {
  it("reads the warehouse route tree", () => {
    expect(surfaceRoutes().length).toBeGreaterThan(20);
  });

  it("exposes no orphan surfaces — every route is reachable from the nav", () => {
    const orphans = surfaceRoutes().filter((route) =>
      // Reachable when the nav links the route itself, or links an ancestor
      // segment from which the route is navigable (e.g. `counts` → `counts/new`).
      !navPaths.some((nav) => route === nav || route.startsWith(`${nav}/`)),
    );
    expect(
      orphans,
      `Warehouse routes unreachable from WAREHOUSE_NAV: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("contains no dead links — every nav target is a declared route", () => {
    const declared = new Set(declaredRoutes());
    const dead = navPaths.filter((p) => !declared.has(p));
    expect(dead, `Nav entries with no matching route: ${dead.join(", ")}`).toEqual([]);
  });

  it("keeps every nav target inside the warehouse app", () => {
    const foreign = navItems.filter((i) => !i.to.startsWith(PREFIX));
    expect(foreign.map((i) => i.to)).toEqual([]);
  });

  it("never nests deeper than two levels", () => {
    const tooDeep = WAREHOUSE_NAV.groups
      .flatMap((g) => g.items)
      .filter((i) => depthOf(i) > 2)
      .map((i) => i.label);
    expect(tooDeep, `Nav items nested deeper than 2: ${tooDeep.join(", ")}`).toEqual([]);
  });

  it("keeps groups scannable — no group exceeds 8 items", () => {
    const bloated = WAREHOUSE_NAV.groups
      .filter((g) => g.items.length > 8)
      .map((g) => `${g.label} (${g.items.length})`);
    expect(
      bloated,
      [
        "A warehouse nav group grew past 8 items — the flat-sidebar regression.",
        "Attach the new surface as `children` of an existing item, or open an",
        "ADR to justify a new domain group.",
        ...bloated,
      ].join("\n"),
    ).toEqual([]);
  });

  it("separates execution from configuration", () => {
    const labels = WAREHOUSE_NAV.groups.map((g) => g.label);
    expect(labels).toContain("Configuration");
    // Configuration must be last so it never competes with execution work.
    expect(labels[labels.length - 1]).toBe("Configuration");
  });

  it("has no duplicate nav targets", () => {
    const dupes = navPaths.filter((p, i) => navPaths.indexOf(p) !== i);
    expect(dupes, `Duplicate nav targets: ${dupes.join(", ")}`).toEqual([]);
  });
});
