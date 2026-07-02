/**
 * AppLayoutContext
 *
 * Two responsibilities:
 *
 * 1. Nested-layout detection — when a page is already inside an
 *    AppWorkspaceLayout, inner layouts (e.g. ReportsLayout) render a
 *    simplified sub-nav instead of a duplicate navbar.
 *
 * 2. Scope declaration slot (F1 from .lovable/plan.md) — pages declare
 *    "this view's figures reflect <scope>" via `useDeclareScope({...})`
 *    and the layout renders a single chip in its header via
 *    `useDeclaredScope()`. This replaces the per-page badge sprinkle
 *    (ScopeBadge / FinanceScopeBadge / DashboardScopeBadge) without
 *    forcing a 17-file rewrite: those three badges also register here,
 *    so any layout that adopts the slot gets a single source of truth.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type DeclaredScopeKind =
  | "business"
  | "branch"
  | "consolidated"
  | "executive";

export interface DeclaredScope {
  kind: DeclaredScopeKind;
  /** Human-readable label, e.g. "AccrualFlow · Nairobi (HQ)". */
  label: string;
  /** Optional secondary tag (e.g. "USD", "FY25"). */
  hint?: string;
}

interface AppLayoutContextValue {
  /** Whether we're already inside an AppWorkspaceLayout. */
  isInsideAppLayout: boolean;
  /** The current parent app ID (e.g., "finance"). */
  parentAppId: string | null;
  /** Last declared scope, or null. */
  declaredScope: DeclaredScope | null;
  /** Internal — pages should not call this directly; use useDeclareScope. */
  _setDeclaredScope: (s: DeclaredScope | null) => void;
  /** When true, the shell drops its max-w cap for the active page. */
  fullWidth: boolean;
  /** Internal — pages should not call this directly; use useRequestFullWidth. */
  _setFullWidth: (v: boolean) => void;
}

const AppLayoutContext = createContext<AppLayoutContextValue>({
  isInsideAppLayout: false,
  parentAppId: null,
  declaredScope: null,
  _setDeclaredScope: () => {},
  fullWidth: false,
  _setFullWidth: () => {},
});

interface AppLayoutProviderProps {
  appId: string;
  children: ReactNode;
}

export function AppLayoutProvider({ appId, children }: AppLayoutProviderProps) {
  const [declaredScope, setDeclaredScope] = useState<DeclaredScope | null>(null);
  const [fullWidth, setFullWidth] = useState(false);
  const value = useMemo<AppLayoutContextValue>(
    () => ({
      isInsideAppLayout: true,
      parentAppId: appId,
      declaredScope,
      _setDeclaredScope: setDeclaredScope,
      fullWidth,
      _setFullWidth: setFullWidth,
    }),
    [appId, declaredScope, fullWidth],
  );
  return (
    <AppLayoutContext.Provider value={value}>
      {children}
    </AppLayoutContext.Provider>
  );
}

export function useAppLayout(): AppLayoutContextValue {
  return useContext(AppLayoutContext);
}

/**
 * Page-side: declare the scope this view's figures reflect. The active app
 * layout's header chip reads it via `useDeclaredScope()`. No-op when not
 * inside an `AppLayoutProvider` — pages stay safe to render standalone.
 *
 * Stable inputs (memoized strings) avoid re-render churn.
 */
export function useDeclareScope(scope: DeclaredScope | null): void {
  const ctx = useContext(AppLayoutContext);
  const key = scope ? `${scope.kind}|${scope.label}|${scope.hint ?? ""}` : "";
  useEffect(() => {
    if (!ctx.isInsideAppLayout) return;
    ctx._setDeclaredScope(scope);
    return () => ctx._setDeclaredScope(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.isInsideAppLayout, key]);
}

/** Layout-side: read the declared scope to render the header chip. */
export function useDeclaredScope(): DeclaredScope | null {
  return useContext(AppLayoutContext).declaredScope;
}

/**
 * Page-side: request that the surrounding shell drops its max-width cap
 * (and uses full viewport width minus chrome) for as long as this page is
 * mounted. No-op when not inside an `AppLayoutProvider`.
 */
export function useRequestFullWidth(enabled = true): void {
  const ctx = useContext(AppLayoutContext);
  useEffect(() => {
    if (!ctx.isInsideAppLayout) return;
    ctx._setFullWidth(enabled);
    return () => ctx._setFullWidth(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.isInsideAppLayout, enabled]);
}

/** Layout-side: read whether the active page requested a full-width canvas. */
export function useFullWidthRequested(): boolean {
  return useContext(AppLayoutContext).fullWidth;
}
