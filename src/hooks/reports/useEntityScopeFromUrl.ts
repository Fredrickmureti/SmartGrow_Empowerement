/**
 * Honour the `business` scope key a cross-entity drill-down carried in.
 *
 * A consolidation drill-down names the member company that owns the record
 * (see `@/lib/reports/crossEntityDrill`). When such a link is opened, the
 * destination report must read that company's books — not the one the viewer
 * last had active — otherwise the figure and the detail disagree.
 *
 * Access is not decided here. `switchBusiness` only accepts a company already
 * in the viewer's access set (`user_business_access`), and every query behind
 * the destination is still filtered by RLS on the server. A `business` value
 * the viewer cannot reach is therefore refused locally *and* would return
 * nothing if it somehow got through: the hook reports `denied` so the page can
 * say so plainly instead of silently showing the wrong company's numbers.
 */

import { useEffect, useMemo, useRef } from "react";
import { useBusiness } from "@/contexts/BusinessContext";
import { useReportWorkspaceState } from "./useReportWorkspaceState";

export interface EntityScopeFromUrl {
  /** Company id requested by the link, if any. */
  requestedBusinessId: string | null;
  /** Name of that company when the viewer may reach it. */
  requestedBusinessName: string | null;
  /** The link named a company the viewer has no access to. */
  denied: boolean;
  /** The active company was switched to satisfy the link. */
  switched: boolean;
}

export function useEntityScopeFromUrl(): EntityScopeFromUrl {
  const workspace = useReportWorkspaceState();
  const { businesses, currentBusiness, switchBusiness, isLoading } = useBusiness();
  const requestedBusinessId = workspace.scope.business ?? null;
  const attempted = useRef<string | null>(null);

  const match = useMemo(
    () => businesses.find((b) => b.id === requestedBusinessId) ?? null,
    [businesses, requestedBusinessId],
  );

  useEffect(() => {
    if (!requestedBusinessId || isLoading) return;
    if (currentBusiness?.id === requestedBusinessId) return;
    if (!match) return;
    if (attempted.current === requestedBusinessId) return;
    attempted.current = requestedBusinessId;
    void switchBusiness(requestedBusinessId);
  }, [requestedBusinessId, match, currentBusiness?.id, isLoading, switchBusiness]);

  return {
    requestedBusinessId,
    requestedBusinessName: match?.name ?? null,
    denied: !!requestedBusinessId && !isLoading && !match,
    switched:
      !!requestedBusinessId &&
      !!match &&
      currentBusiness?.id === requestedBusinessId,
  };
}
