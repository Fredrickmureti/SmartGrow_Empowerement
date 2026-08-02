/**
 * Architecture guard — the app switcher must never silently hide an app.
 *
 * Regression: `getAppGroups()` used hardcoded id allow-lists per category, so
 * newly registered apps (Warehouse, Talent) and apps missing from
 * `APP_REGISTRY` (Reports) never appeared in the switcher — the only way to
 * change apps on mobile, where the AppRail is hidden.
 */
import { describe, it, expect } from "vitest";
import { APP_REGISTRY, getAppGroups } from "@/lib/apps/registry";

describe("app switcher coverage", () => {
  const groups = getAppGroups();
  const groupedIds = new Set(groups.flatMap((g) => g.apps.map((a) => a.id)));

  it("every registered app is reachable from the switcher (except `me`)", () => {
    const missing = APP_REGISTRY.filter(
      (app) => app.id !== "me" && !app.hideAppSwitcher && !groupedIds.has(app.id),
    ).map((app) => app.id);
    expect(missing, `Apps missing from getAppGroups(): ${missing.join(", ")}`).toEqual([]);
  });

  it("no app is listed in more than one group", () => {
    const seen = new Map<string, number>();
    for (const g of groups) for (const a of g.apps) seen.set(a.id, (seen.get(a.id) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([]);
  });

  it("core operational apps are registered and grouped", () => {
    for (const id of ["warehouse", "reports", "talent", "inventory", "pos"]) {
      expect(APP_REGISTRY.some((a) => a.id === id), `${id} not in APP_REGISTRY`).toBe(true);
      expect(groupedIds.has(id), `${id} not grouped`).toBe(true);
    }
  });

  it("groups are never empty", () => {
    expect(groups.filter((g) => g.apps.length === 0)).toEqual([]);
  });
});
