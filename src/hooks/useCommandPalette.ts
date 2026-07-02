/**
 * useCommandPalette
 *
 * The brain of the global command palette. Combines:
 *   - the static command index (apps + pages + actions + reports)
 *   - permission / entitlement / install / portal-user gating
 *   - the user's current app context (boosts in-context results)
 *   - the local recency/frequency store
 *   - the fuzzy search + ranking engine
 *
 * Returns a fully-ranked list of results that the palette UI can render
 * with zero additional logic. All filtering/ranking work is memoised
 * against stable dependencies so keystrokes are cheap.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "@/contexts/SessionContext";
import { usePermissions } from "@/hooks/usePermissions";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { useCommandUsage } from "@/hooks/useCommandUsage";
import { useCommandProviders } from "@/hooks/useCommandProviders";
import { getStaticCommandIndex } from "@/lib/command/buildIndex";
import { APP_REGISTRY } from "@/lib/apps/registry";
import { rankEntries, buildEmptyStateBuckets } from "@/lib/command/rank";
import { parseQuery } from "@/lib/command/parseQuery";
import { detectSurface, type ActiveSurface } from "@/lib/command/surface";
import { logCommandEvent } from "@/lib/command/telemetry";
import type {
  CommandEntry, CommandRunContext, RankedEntry,
} from "@/lib/command/types";
import type { CommandProvider } from "@/lib/command/providers/types";
import type { Permission } from "@/lib/permissions";

interface UseCommandPaletteResult {
  open: boolean;
  setOpen: (v: boolean) => void;
  query: string;
  setQuery: (v: string) => void;
  /** Top-ranked results for the current query. */
  results: RankedEntry[];
  /** Async record/AI provider results, grouped. */
  providerGroups: Array<{ provider: CommandProvider; entries: CommandEntry[] }>;
  /** True while async providers are in flight. */
  providersLoading: boolean;
  /** Empty-state buckets (only populated when query is empty). */
  empty: {
    pinned: CommandEntry[];
    recent: CommandEntry[];
    frequent: CommandEntry[];
    suggested: CommandEntry[];
  };
  /**
   * Marketplace fallback — entries the user matched but cannot reach
   * because the owning app isn't installed. Selecting one navigates
   * to `/apps/:appId/activate`. Empty unless query is non-empty AND
   * permissions/entitlements would otherwise allow access.
   */
  marketplace: Array<{ appId: string; appName: string; entry: CommandEntry }>;
  /** Execute the entry: navigate or run, record usage, close palette. */
  run: (entry: CommandEntry) => void;
  /** Pin/unpin helpers. */
  isPinned: (entryId: string) => boolean;
  togglePin: (entryId: string) => void;
  /** Total accessible entries (after gating). Useful for diagnostics. */
  accessibleCount: number;
  /** Parsed query — exposes active scope/provider hints for UI chips. */
  parsed: ReturnType<typeof parseQuery>;
  /** Current app id (e.g. "sales") — used to show "switch app" hints. */
  currentAppId: string | null;
  /** Active workspace surface — drives which entries the index returns. */
  activeSurface: ActiveSurface;
}

/** Type-tagged accessor for the optional `__permissionsAny` extension. */
function getPermissionsAny(entry: CommandEntry): Permission[] | undefined {
  return (entry as unknown as { __permissionsAny?: Permission[] }).__permissionsAny;
}

export function useCommandPalette(): UseCommandPaletteResult {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const navigate = useNavigate();
  const location = useLocation();
  const { hasEntitlement, userType, currentOrg, isPlatformAdmin } = useSession();
  const permissions = usePermissions();
  const { isInstalled, installedAppIds } = useInstalledApps();
  const { currentApp } = useAppNavigation();
  const { usage, pinned, record, isPinned, togglePin } = useCommandUsage();

  // Static index — built once, frozen.
  const allEntries = useMemo(() => getStaticCommandIndex(), []);

  // Active workspace surface — drives which entries the index returns.
  // Route-driven (NOT role-driven) so a platform admin operating inside
  // a tenant workspace sees the tenant palette there, and the tenant
  // palette never leaks into the admin console. See `surface.ts`.
  const activeSurface = useMemo(
    () => detectSurface(location.pathname, isPlatformAdmin),
    [location.pathname, isPlatformAdmin],
  );

  /**
   * Surface gate. Applied to every accessibility filter so empty-state
   * buckets, ranked results, AND marketplace candidates all share the
   * same "what makes sense on this surface" rule.
   */
  const passesSurface = useCallback(
    (e: CommandEntry): boolean => {
      const entrySurface = e.surface ?? "tenant";
      if (entrySurface === "any") return true;
      if (entrySurface !== activeSurface) return false;
      // Defense in depth: even if a tenant user somehow lands on /admin,
      // platform-only entries stay invisible without the platform-admin role.
      if (entrySurface === "platform" && !isPlatformAdmin) return false;
      return true;
    },
    [activeSurface, isPlatformAdmin],
  );

  // Permission/entitlement/install filter. Memoised by stable signals
  // so a keystroke does NOT re-walk the full index.
  const permFingerprint = `${permissions.role ?? ""}`;
  const installFingerprint = [...installedAppIds].sort().join(",");
  const accessible = useMemo(() => {
    const isPortal = userType === "portal";
    return allEntries.filter((e) => {
      // Surface gate first — cheapest check, biggest cull.
      if (!passesSurface(e)) return false;

      if (e.internalOnly && isPortal) return false;
      if (e.appInstall && !isInstalled(e.appInstall)) return false;
      if (e.feature && !hasEntitlement(e.feature)) return false;

      // Permission: support a single perm OR an "any-of" list.
      const anyPerms = getPermissionsAny(e);
      if (anyPerms && anyPerms.length > 0) {
        if (!anyPerms.some(p => permissions.can(p))) return false;
      } else if (e.permission && !permissions.can(e.permission)) {
        return false;
      }

      return true;
    });
    // intentionally stable deps — fingerprints capture the rest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEntries, userType, permFingerprint, installFingerprint, currentOrg?.id, activeSurface, isPlatformAdmin]);

  /**
   * Marketplace candidates: entries the user *would* be allowed to use
   * if the owning app were installed. We keep permission / entitlement
   * / portal / surface gating intact — the only blocker we relax is
   * `appInstall`. This avoids advertising apps the user has no right
   * to use anyway, AND keeps the admin console free of "install Sales"
   * suggestions.
   */
  const marketplaceCandidates = useMemo(() => {
    const isPortal = userType === "portal";
    return allEntries.filter((e) => {
      if (!e.appInstall) return false;
      if (isInstalled(e.appInstall)) return false;
      if (!passesSurface(e)) return false;
      if (e.internalOnly && isPortal) return false;
      if (e.feature && !hasEntitlement(e.feature)) return false;
      const anyPerms = getPermissionsAny(e);
      if (anyPerms && anyPerms.length > 0) {
        if (!anyPerms.some(p => permissions.can(p))) return false;
      } else if (e.permission && !permissions.can(e.permission)) {
        return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEntries, userType, permFingerprint, installFingerprint, currentOrg?.id, activeSurface, isPlatformAdmin]);

  const currentAppId = currentApp?.id ?? null;

  // Parse smart prefixes (`>`, `#`, `?`, alias-hints like "inv 1042").
  const parsed = useMemo(() => parseQuery(query), [query]);

  const results = useMemo(() => {
    // When the user explicitly scopes to a record kind, the static
    // index has nothing useful to offer — providers handle records.
    if (parsed.kindScope === "record") return [] as RankedEntry[];

    const ranked = rankEntries(accessible, {
      query: parsed.text,
      currentAppId,
      usage,
      limit: 30,
    });

    if (!parsed.kindScope) return ranked;
    return ranked.filter((r) => r.entry.kind === parsed.kindScope);
  }, [accessible, parsed, currentAppId, usage]);

  /**
   * Marketplace fallback — only populated when there's a query AND
   * candidate entries match it. Collapsed to one suggestion per app
   * (highest-scoring) so we surface the *app to install*, not a flood
   * of inaccessible pages.
   */
  const marketplace = useMemo<UseCommandPaletteResult["marketplace"]>(() => {
    if (!parsed.text.trim() || parsed.kindScope === "record") return [];
    const ranked = rankEntries(marketplaceCandidates, {
      query: parsed.text,
      currentAppId,
      usage,
      limit: 50,
    });
    const seen = new Map<string, { appId: string; appName: string; entry: CommandEntry }>();
    for (const r of ranked) {
      const appId = r.entry.appInstall;
      if (!appId || seen.has(appId)) continue;
      const app = APP_REGISTRY.find((a) => a.id === appId);
      seen.set(appId, {
        appId,
        appName: app?.name ?? appId,
        entry: r.entry,
      });
    }
    return Array.from(seen.values()).slice(0, 5);
  }, [marketplaceCandidates, parsed, currentAppId, usage]);

  const empty = useMemo(() => {
    const buckets = buildEmptyStateBuckets(accessible, usage, currentAppId);
    const byId = new Map(accessible.map((e) => [e.id, e] as const));
    const pinnedEntries = pinned
      .map((id) => byId.get(id))
      .filter((e): e is CommandEntry => !!e);
    const pinnedIds = new Set(pinned);
    return {
      pinned: pinnedEntries,
      // Avoid duplicating a pinned entry inside Recent/Frequent/Suggested.
      recent: buckets.recent.filter((e) => !pinnedIds.has(e.id)),
      frequent: buckets.frequent.filter((e) => !pinnedIds.has(e.id)),
      suggested: buckets.suggested.filter((e) => !pinnedIds.has(e.id)),
    };
  }, [accessible, usage, currentAppId, pinned]);

  const { groups: providerGroups, loading: providersLoading } =
    useCommandProviders(parsed.text, currentAppId, open, {
      kindFilter: parsed.kindScope,
      providerIdFilter: parsed.providerScope,
    });

  /**
   * Zero-result telemetry. Fires when the user has typed a meaningful
   * query, providers have settled, and nothing matched anywhere.
   */
  const totalResults =
    results.length +
    providerGroups.reduce((s, g) => s + g.entries.length, 0) +
    marketplace.length;

  useEffect(() => {
    if (!open) return;
    const text = parsed.text.trim();
    if (text.length < 2) return;
    if (providersLoading) return;
    if (totalResults > 0) return;
    const t = setTimeout(() => {
      logCommandEvent({
        eventType: "zero_result",
        query: parsed.raw,
        resultCount: 0,
        currentAppId,
        organizationId: currentOrg?.id ?? null,
      });
    }, 600);
    return () => clearTimeout(t);
  }, [open, parsed.text, parsed.raw, providersLoading, totalResults, currentAppId, currentOrg?.id]);

  const run = useCallback(
    (entry: CommandEntry) => {
      record(entry.id);
      logCommandEvent({
        eventType: "select",
        query: parsed.raw,
        resultCount: totalResults,
        selectedId: entry.id,
        selectedKind: entry.kind,
        currentAppId,
        organizationId: currentOrg?.id ?? null,
      });
      setOpen(false);
      setQuery("");

      const ctx: CommandRunContext = {
        navigate: (to: string) => navigate(to),
        closePalette: () => setOpen(false),
        currentAppId,
      };

      if (entry.run) {
        void entry.run(ctx);
      } else if (entry.to) {
        navigate(entry.to);
      }
    },
    [navigate, record, currentAppId, parsed.raw, totalResults, currentOrg?.id],
  );

  return {
    open, setOpen,
    query, setQuery,
    results,
    providerGroups,
    providersLoading,
    empty,
    marketplace,
    run,
    isPinned,
    togglePin,
    accessibleCount: accessible.length,
    parsed,
    currentAppId,
    activeSurface,
  };
}
