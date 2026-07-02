/**
 * FinanceScopeBadge — declaration-only shim (Phase B-sweep, 2026-06-03).
 *
 * Historically this component rendered an inline scope chip in each
 * Finance page header AND declared the active scope to the layout via
 * `useDeclareScope`. After Phase B-sweep, the visible chip lives once
 * in `AppTopNavbar` via `<DeclaredScopeChip />`, so this component now
 * only performs the declaration and renders nothing. Existing JSX call
 * sites (`<FinanceScopeBadge />`) continue to compile and continue to
 * feed the layout chip — they just stop double-rendering.
 *
 * Prefer `useDeclareFinanceScope()` directly in new code.
 */
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useDeclareScope } from "@/contexts/AppLayoutContext";

export function useDeclareFinanceScope(): void {
  const { scopeLabel, isConsolidated, hasMultipleBranches } = useFinanceScope();
  useDeclareScope(
    hasMultipleBranches
      ? { kind: isConsolidated ? "consolidated" : "branch", label: scopeLabel }
      : null,
  );
}

interface FinanceScopeBadgeProps {
  className?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function FinanceScopeBadge(_props: FinanceScopeBadgeProps = {}) {
  useDeclareFinanceScope();
  return null;
}
