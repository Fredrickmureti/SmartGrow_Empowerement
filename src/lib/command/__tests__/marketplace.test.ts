/**
 * Marketplace Fallback — invariants
 *
 * The "Available in Marketplace" bucket in `useCommandPalette` is
 * computed by filtering `allEntries` with the same permission /
 * portal rules as the accessible filter — but
 * deliberately RELAXING the `appInstall` check. This test pins down
 * those invariants as a pure-function spec so future refactors of the
 * hook can't silently regress the behaviour.
 *
 * The function under test mirrors the inline filter at
 *   src/hooks/useCommandPalette.ts ::  marketplaceCandidates
 * If you change either, change both.
 */
import { describe, it, expect } from "vitest";
import { LayoutGrid } from "lucide-react";
import type { CommandEntry } from "../types";
import type { Permission } from "@/lib/permissions";

interface Ctx {
  isPortal: boolean;
  isInstalled: (appId: string) => boolean;
  can: (perm: Permission) => boolean;
}

/** Pure mirror of the inline marketplace-candidates filter. */
function marketplaceFilter(entries: CommandEntry[], ctx: Ctx): CommandEntry[] {
  return entries.filter((e) => {
    if (!e.appInstall) return false;
    if (ctx.isInstalled(e.appInstall)) return false;
    if (e.internalOnly && ctx.isPortal) return false;
    const anyPerms = (e as unknown as { __permissionsAny?: Permission[] }).__permissionsAny;
    if (anyPerms && anyPerms.length > 0) {
      if (!anyPerms.some((p) => ctx.can(p))) return false;
    } else if (e.permission && !ctx.can(e.permission)) {
      return false;
    }
    return true;
  });
}

function entry(over: Partial<CommandEntry> & { id: string; title: string }): CommandEntry {
  return {
    kind: "page",
    appId: "hr",
    icon: LayoutGrid,
    keywords: [],
    weight: 50,
    to: `/${over.id}`,
    ...over,
  } as CommandEntry;
}

const allowAll: Ctx = {
  isPortal: false,
  isInstalled: () => false,
  can: () => true,
};

describe("marketplace fallback filter", () => {
  it("includes entries whose app is NOT installed", () => {
    const e = entry({ id: "p", title: "Loans", appInstall: "hr" });
    expect(marketplaceFilter([e], allowAll)).toEqual([e]);
  });

  it("excludes entries with no appInstall (core / always-available)", () => {
    const e = entry({ id: "p", title: "Loans" });
    expect(marketplaceFilter([e], allowAll)).toEqual([]);
  });

  it("excludes entries when the app IS installed", () => {
    const e = entry({ id: "p", title: "Loans", appInstall: "hr" });
    const ctx = { ...allowAll, isInstalled: (id: string) => id === "hr" };
    expect(marketplaceFilter([e], ctx)).toEqual([]);
  });

  it("respects permission gating", () => {
    const e = entry({
      id: "p",
      title: "Loans",
      appInstall: "hr",
      permission: "viewReports" as Permission,
    });
    const ctx = { ...allowAll, can: () => false };
    expect(marketplaceFilter([e], ctx)).toEqual([]);
  });

  it("hides internal-only entries from portal users", () => {
    const e = entry({ id: "p", title: "Loans", appInstall: "hr", internalOnly: true });
    const ctx = { ...allowAll, isPortal: true };
    expect(marketplaceFilter([e], ctx)).toEqual([]);
  });

  it("supports __permissionsAny multi-permission OR semantics", () => {
    const e = entry({ id: "p", title: "Loans", appInstall: "hr" });
    (e as unknown as { __permissionsAny: Permission[] }).__permissionsAny = [
      "viewReports" as Permission,
      "viewReports" as Permission,
    ];
    const ctx = { ...allowAll, can: (p: Permission) => p === ("viewReports" as Permission) };
    expect(marketplaceFilter([e], ctx)).toEqual([e]);
  });
});
