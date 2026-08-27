/**
 * Cross-entity drill targets (Consolidation traceability contract, rule 3).
 *
 * A consolidated figure belongs to the group; the records beneath it belong to
 * one member company. A drill-down that only names an account therefore lands
 * in whatever company the viewer happened to have active — usually showing an
 * empty ledger, occasionally showing the *wrong* company's numbers under the
 * right heading. Both outcomes destroy traceability.
 *
 * Every cross-entity link therefore names the company explicitly, in the
 * canonical reporting scope key `business`, alongside the ordinary reporting
 * scope (`contact` = account, `from`/`to` = period) already owned by
 * `useReportWorkspaceState`. No new URL convention is invented here: this is
 * the existing convention plus the one dimension consolidation adds.
 *
 * These builders decide nothing about permission. Whether the viewer may open
 * a member company's books is the server's decision (RLS plus the evidence
 * RPC's `viewer_can_open_ledger`); the destination re-checks it independently,
 * so a hand-typed URL is no more powerful than a rendered link.
 */

import { scopeToSearch } from "@/hooks/reports/useReportWorkspaceState";

export interface CrossEntityLedgerTarget {
  /** Company that owns the ledger being opened. */
  businessId: string | null | undefined;
  /** Account in that company's own chart, not the group account. */
  accountId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

/** Deep link to a member company's General Ledger, period and account intact. */
export function ledgerDrillHref({
  businessId,
  accountId,
  dateFrom,
  dateTo,
}: CrossEntityLedgerTarget): string {
  const search = scopeToSearch({
    business: businessId ?? undefined,
    contact: accountId ?? undefined,
    from: dateFrom ?? undefined,
    to: dateTo ?? undefined,
  });
  return `/finance/reports/general-ledger${search}`;
}

/**
 * Deep link to a journal entry in a member company's books. The entry id is
 * globally unique, but the company still travels with it so the destination
 * opens in the same accounting context the consolidated figure referred to.
 */
export function journalEntryDrillHref(
  journalEntryId: string,
  businessId?: string | null,
): string {
  const search = scopeToSearch({ business: businessId ?? undefined });
  return `/finance/journal-entries/${journalEntryId}${search}`;
}
