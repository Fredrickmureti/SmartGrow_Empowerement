/**
 * useReportWorkspaceState — the single owner of reporting *navigation state*.
 *
 * Reporting is stateful, and the state has four tiers:
 *
 *   transient  — hover, open menus, in-flight text. Local `useState`. Not here.
 *   navigation — period / date range / as-of / branch / department / grouping /
 *                sorting / search. MUST survive a drill-down and the browser
 *                Back button. Owned here, carried in the URL query string.
 *   workspace  — the same navigation keys, carried forward when the user
 *                switches to a related report (see `toReportSearch`).
 *   saved      — explicitly persisted views (`useReportSavedViews`). Not here.
 *
 * Because navigation state lives in the URL, Back/Forward, deep links, refresh
 * and drill-return all work through ordinary history — no history hacks, no
 * global store, no per-page bespoke persistence.
 */

import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/** Keys that constitute reporting scope. Anything else is transient. */
export const REPORT_SCOPE_KEYS = [
  "period",
  "from",
  "to",
  "asOf",
  // The member company a drill-down belongs to. Single-company reports never
  // set it; consolidation drill-downs always do, because the record beneath a
  // group figure lives in one company's books and the destination must open
  // in that company rather than in whichever one happened to be active.
  "business",
  "branch",
  "department",
  "employee",
  "contact",
  "run",
  "basis",
  "group",
  "sort",
  "dir",
  "q",
  "status",
  "currency",
  "compare",
] as const;


export type ReportScopeKey = (typeof REPORT_SCOPE_KEYS)[number];

export type ReportScope = Partial<Record<ReportScopeKey, string>>;

function isScopeKey(key: string): key is ReportScopeKey {
  return (REPORT_SCOPE_KEYS as readonly string[]).includes(key);
}

/** Extract only the scope keys from a `URLSearchParams`. */
export function readScope(params: URLSearchParams): ReportScope {
  const scope: ReportScope = {};
  params.forEach((value, key) => {
    if (isScopeKey(key) && value !== "") scope[key] = value;
  });
  return scope;
}

/** Serialise a scope to a query string (stable key order, empties dropped). */
export function scopeToSearch(scope: ReportScope): string {
  const params = new URLSearchParams();
  for (const key of REPORT_SCOPE_KEYS) {
    const value = scope[key];
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export interface ReportWorkspaceState {
  /** Current reporting scope, read from the URL. */
  scope: ReportScope;
  /** Read one scope value with a fallback, so pages never branch on undefined. */
  get: (key: ReportScopeKey, fallback: string) => string;
  /**
   * Merge scope values into the URL. `replace` keeps history clean for
   * high-frequency edits (typing in a search box); the default pushes so the
   * Back button walks the user's own investigation steps.
   */
  set: (next: ReportScope, options?: { replace?: boolean }) => void;
  /** Clear scope keys (all of them, or a named subset). */
  reset: (keys?: ReportScopeKey[]) => void;
  /**
   * Query string to append when navigating to another report or a drill-down
   * route, so the destination inherits the current reporting scope.
   */
  toReportSearch: (overrides?: ReportScope) => string;
}

export function useReportWorkspaceState(
  defaults: ReportScope = {},
): ReportWorkspaceState {
  const [params, setParams] = useSearchParams();

  const scope = useMemo(() => {
    const fromUrl = readScope(params);
    return { ...defaults, ...fromUrl };
    // `defaults` is a literal at most call sites; key on its serialisation so
    // a fresh object identity each render does not churn the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, JSON.stringify(defaults)]);

  const set = useCallback(
    (next: ReportScope, options?: { replace?: boolean }) => {
      setParams(
        (prev) => {
          const merged = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(next)) {
            if (!isScopeKey(key)) continue;
            if (value === undefined || value === "") merged.delete(key);
            else merged.set(key, value);
          }
          return merged;
        },
        { replace: options?.replace ?? false },
      );
    },
    [setParams],
  );

  const reset = useCallback(
    (keys?: ReportScopeKey[]) => {
      setParams(
        (prev) => {
          const merged = new URLSearchParams(prev);
          for (const key of keys ?? REPORT_SCOPE_KEYS) merged.delete(key);
          return merged;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const get = useCallback(
    (key: ReportScopeKey, fallback: string) => scope[key] ?? fallback,
    [scope],
  );

  const toReportSearch = useCallback(
    (overrides?: ReportScope) => scopeToSearch({ ...scope, ...overrides }),
    [scope],
  );

  return { scope, get, set, reset, toReportSearch };
}
