/**
 * useCommandProviders
 *
 * Runs every registered async provider for the current query in
 * parallel, with debouncing and abort-on-keystroke. Results are
 * cached per (providerId, query) so re-typing a previous query is
 * instant.
 *
 * Performance contract:
 *   - No fetch fires while the query is shorter than the provider's
 *     `minQueryLength`.
 *   - Each keystroke aborts in-flight requests; only the final query
 *     resolves into state.
 *   - The static index is NEVER blocked on these results — they merge
 *     into the palette below the static set as they arrive.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { COMMAND_PROVIDERS } from "@/lib/command/providers/registry";
import { usePermissions } from "@/hooks/usePermissions";
import type { CommandEntry, CommandKind } from "@/lib/command/types";
import type { CommandProvider } from "@/lib/command/providers/types";

const DEFAULT_DEBOUNCE_MS = 150;

interface UseCommandProvidersOptions {
  /** Restrict to providers whose kind matches (set by `#` prefix). */
  kindFilter?: CommandKind | null;
  /** Restrict to a single provider id (set by smart numeric pattern). */
  providerIdFilter?: string | null;
}

interface UseCommandProvidersResult {
  /** Async results, grouped by provider, in registration order. */
  groups: Array<{ provider: CommandProvider; entries: CommandEntry[] }>;
  /** True while at least one provider request is in flight. */
  loading: boolean;
}

const cache = new Map<string, CommandEntry[]>();
const cacheKey = (providerId: string, q: string) => `${providerId}::${q}`;
/** Cap the cache so heavy typing sessions don't grow unbounded. */
const MAX_CACHE = 200;

export function useCommandProviders(
  query: string,
  currentAppId: string | null,
  enabled: boolean,
  options: UseCommandProvidersOptions = {},
): UseCommandProvidersResult {
  const [groups, setGroups] = useState<UseCommandProvidersResult["groups"]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const permissions = usePermissions();
  const { kindFilter = null, providerIdFilter = null } = options;

  /**
   * Permission-gate providers up-front. We compute a stable fingerprint
   * of allowed provider ids so an unstable `permissions` object reference
   * (common when upstream hooks re-create their return value each render)
   * does NOT thrash this memo and re-trigger the effect → setState loop.
   *
   * Both the fingerprint AND the filtered list are memoised on the
   * permissions object so a parent re-render does NOT re-walk the
   * provider registry or re-invoke `permissions.can(...)` per render.
   */
  const allowedFingerprint = useMemo(
    () =>
      COMMAND_PROVIDERS
        .filter((p) => !p.permission || permissions.can(p.permission))
        .map((p) => p.id)
        .join(","),
    [permissions],
  );
  const allowedProviders = useMemo(
    () =>
      COMMAND_PROVIDERS.filter(
        (p) => !p.permission || permissions.can(p.permission),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allowedFingerprint],
  );

  useEffect(() => {
    // Tear down any pending work from the previous keystroke.
    if (timerRef.current) clearTimeout(timerRef.current);
    if (abortRef.current) abortRef.current.abort();

    const q = query.trim();
    if (!enabled || !q) {
      // Guard setState with referential checks — passing a fresh `[]`
      // every render would otherwise re-trigger this effect via parent
      // re-renders even when the value hasn't logically changed.
      setGroups((prev) => (prev.length === 0 ? prev : []));
      setLoading((prev) => (prev ? false : prev));
      return;
    }

    // Pick providers eligible for this query length + prefix scope.
    const eligible = allowedProviders.filter((p) => {
      if (q.length < p.minQueryLength) return false;
      if (kindFilter && (p.kind ?? "record") !== kindFilter) return false;
      if (providerIdFilter && p.id !== providerIdFilter) return false;
      return true;
    });
    if (eligible.length === 0) {
      setGroups([]);
      setLoading(false);
      return;
    }

    const debounceMs = Math.max(
      0,
      Math.min(...eligible.map((p) => p.debounceMs ?? DEFAULT_DEBOUNCE_MS)),
    );

    timerRef.current = setTimeout(() => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);

      // Fire all providers in parallel, settle individually.
      const tasks = eligible.map(async (provider) => {
        const key = cacheKey(provider.id, q);
        if (cache.has(key)) {
          return { provider, entries: cache.get(key)! };
        }
        try {
          const raw = await provider.fetch(q, {
            currentAppId,
            signal: ctrl.signal,
          });
          const limited = raw.slice(0, provider.limit ?? 8);
          if (!ctrl.signal.aborted) {
            if (cache.size >= MAX_CACHE) {
              const firstKey = cache.keys().next().value;
              if (firstKey) cache.delete(firstKey);
            }
            cache.set(key, limited);
          }
          return { provider, entries: limited };
        } catch {
          return { provider, entries: [] as CommandEntry[] };
        }
      });

      Promise.all(tasks).then((results) => {
        if (ctrl.signal.aborted) return;
        setGroups(results.filter((g) => g.entries.length > 0));
        setLoading(false);
      });
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, currentAppId, enabled, allowedProviders, kindFilter, providerIdFilter]);

  return { groups, loading };
}
