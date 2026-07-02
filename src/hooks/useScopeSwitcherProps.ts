/**
 * useScopeSwitcherProps — adapter that returns the consolidated-view
 * props for ContextSwitcherSheet when the active user is server-side
 * authorized for `dashboard.view_consolidated`. Lets the canonical
 * switcher sheet host the "All Branches (Consolidated)" option without
 * a parallel dropdown (Phase C). Returns no-op props when consolidated
 * is not available so unaware callers can spread it unconditionally.
 */
import { useDashboardScope } from "@/hooks/useDashboardScope";
import { useBranch } from "@/contexts/BranchContext";

export interface ScopeSwitcherConsolidatedProps {
  consolidatedAvailable: boolean;
  consolidatedActive: boolean;
  onSetConsolidated: (v: boolean) => void;
}

export function useScopeSwitcherProps(): ScopeSwitcherConsolidatedProps {
  const { isConsolidatedAuthorized } = useDashboardScope();
  const { consolidatedView, setConsolidatedView } = useBranch();
  return {
    consolidatedAvailable: !!isConsolidatedAuthorized,
    consolidatedActive: !!consolidatedView,
    onSetConsolidated: setConsolidatedView,
  };
}