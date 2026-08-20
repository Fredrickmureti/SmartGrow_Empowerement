/**
 * usePartnerLedger — the Partner Ledger report hook.
 *
 * Thin wrapper over `fetchPartnerLedger` / `fetchPartnerLedgerReconciliation`.
 * All arithmetic lives in SQL; this hook only carries scope and cache keys.
 */

import { useQuery } from "@tanstack/react-query";
import {
  EMPTY_PARTNER_LEDGER_TOTALS,
  fetchPartnerLedger,
  fetchPartnerLedgerReconciliation,
  type PartnerLedgerResult,
  type PartnerLedgerSide,
} from "@/services/finance/partnerLedger";

export interface UsePartnerLedgerOptions {
  orgId: string | null | undefined;
  businessId: string | null | undefined;
  branchId?: string | null;
  side: PartnerLedgerSide;
  from: string;
  to: string;
  contactId?: string | null;
  search?: string | null;
  limit?: number | null;
  offset?: number;
  enabled?: boolean;
}

const EMPTY_RESULT = (side: PartnerLedgerSide, to: string): PartnerLedgerResult => ({
  side: side === "supplier" ? "vendor" : "customer",
  from: null,
  to,
  currency: null,
  partners: [],
  totals: { ...EMPTY_PARTNER_LEDGER_TOTALS },
  page: { limit: null, offset: 0, search: null, returned: 0, has_more: false },
});

export function usePartnerLedger(options: UsePartnerLedgerOptions) {
  const {
    orgId,
    businessId,
    branchId = null,
    side,
    from,
    to,
    contactId = null,
    search = null,
    limit = null,
    offset = 0,
    enabled = true,
  } = options;

  const query = useQuery({
    queryKey: [
      "partner-ledger",
      orgId,
      businessId,
      branchId,
      side,
      from,
      to,
      contactId,
      search,
      limit,
      offset,
    ],
    queryFn: () =>
      fetchPartnerLedger({
        orgId: orgId as string,
        businessId: businessId as string,
        branchId,
        side,
        from,
        to,
        contactId,
        search,
        limit,
        offset,
      }),
    enabled: Boolean(enabled && orgId && businessId),
  });

  return {
    ...query,
    data: query.data ?? EMPTY_RESULT(side, to),
    partners: query.data?.partners ?? [],
    totals: query.data?.totals ?? { ...EMPTY_PARTNER_LEDGER_TOTALS },
  };
}

/** GL tie-out for the partner ledger's closing position. */
export function usePartnerLedgerReconciliation(options: {
  orgId: string | null | undefined;
  businessId: string | null | undefined;
  branchId?: string | null;
  side: PartnerLedgerSide;
  to: string;
  enabled?: boolean;
}) {
  const { orgId, businessId, branchId = null, side, to, enabled = true } = options;

  return useQuery({
    queryKey: ["partner-ledger-reconciliation", orgId, businessId, branchId, side, to],
    queryFn: () =>
      fetchPartnerLedgerReconciliation({
        orgId: orgId as string,
        businessId: businessId as string,
        branchId,
        side,
        to,
      }),
    enabled: Boolean(enabled && orgId && businessId),
  });
}
