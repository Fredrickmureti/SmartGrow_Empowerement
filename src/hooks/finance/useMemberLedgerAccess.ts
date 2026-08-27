/**
 * May this viewer open a member company's own books?
 *
 * Consolidation deliberately shows more than a viewer can drill into: a group
 * figure is the group's, and seeing a company's *contribution* to it is not the
 * same right as reading that company's ledger. Where the server already says so
 * per row (`viewer_can_open_ledger` on the elimination evidence RPC) that answer
 * wins. Where an RPC returns no such flag, this hook supplies the same rail from
 * the viewer's company access set (`user_business_access`, loaded by
 * `BusinessProvider`).
 *
 * This is a rail, not a boundary. It decides whether to *render* a link; the
 * destination re-resolves the company and every query behind it is still
 * filtered by RLS on the server, so a hand-typed URL gains nothing. Never treat
 * the absence of a button as the security control.
 */

import { useCallback } from "react";
import { useBusinesses } from "@/contexts/BusinessContext";

export interface MemberLedgerAccess {
  canOpen: (businessId: string | null | undefined) => boolean;
  isLoading: boolean;
}

export function useMemberLedgerAccess(): MemberLedgerAccess {
  const { businesses, isLoading } = useBusinesses();
  const canOpen = useCallback(
    (businessId: string | null | undefined) =>
      !!businessId && businesses.some((b) => b.id === businessId),
    [businesses],
  );
  return { canOpen, isLoading };
}
