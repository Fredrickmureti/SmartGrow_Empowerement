/**
 * Residual remedies — the one place that maps an engine finding to the act
 * that resolves it.
 *
 * The reconciliation engine (`finance_bank_reconciliation_statement`) names
 * the cause of an unexplained difference; it deliberately does not prescribe
 * a cure, because a cure is a posting and postings belong to their own seams.
 * This table is therefore *navigation and wording only*: it turns a finding
 * into "where do I go, and what am I expected to do there".
 *
 * It performs no arithmetic and mutates nothing. Adding a code here can never
 * change a reported figure.
 */

import type { ResidualExplanationRef } from "@/services/finance/bankReconciliationStatement";

export interface RemedyContext {
  bankAccountId: string | null;
  /** Latest reconciliation session for this account, when one exists. */
  sessionId?: string | null;
}

export interface RemedyLink {
  label: string;
  href: string;
}

export interface ResidualRemedy {
  /** Imperative one-liner: what the accountant is expected to do. */
  action: string;
  /** Why this is the correct act, in accounting terms. */
  guidance: string;
  /** Where to do it, when the finding as a whole has a single destination. */
  primary?: (ctx: RemedyContext) => RemedyLink | null;
  /** Where to inspect one offending row. */
  forRef?: (ref: ResidualExplanationRef, ctx: RemedyContext) => RemedyLink | null;
}

const journalEntryLink = (ref: ResidualExplanationRef): RemedyLink | null =>
  ref.journalEntryId
    ? { label: "Open journal entry", href: `/finance/journal-entries/${ref.journalEntryId}` }
    : null;

const sessionLink =
  (label: string) =>
  (ctx: RemedyContext): RemedyLink | null =>
    ctx.sessionId
      ? { label, href: `/finance/reconciliation?session=${ctx.sessionId}` }
      : { label, href: "/finance/reconciliation" };

export const RESIDUAL_REMEDIES: Record<string, ResidualRemedy> = {
  duplicate_opening_balance: {
    action: "Void the redundant opening-balance entry",
    guidance:
      "The opening balance is posted once, when the bank account is set up. A statement line classified back to the bank's own control account counts it a second time. Void the later entry — never edit the posted one — and leave the setup entry standing.",
    forRef: journalEntryLink,
  },
  unmatched_equal_pairs: {
    action: "Match the pairs in the reconciliation workspace",
    guidance:
      "A statement line and a posted entry of the same amount and date are both sitting unmatched. Confirming the match clears both sides at once; no new posting is created.",
    primary: sessionLink("Open reconciliation"),
    forRef: journalEntryLink,
  },
  sign_flipped_pairs: {
    action: "Correct the direction of the posting",
    guidance:
      "A receipt has been posted as a payment (or the reverse), so the difference is twice the amount. Void the entry and re-post it in the correct direction rather than adjusting the document.",
    forRef: journalEntryLink,
  },
  cleared_without_posting: {
    action: "Post or un-match the cleared lines",
    guidance:
      "These lines are marked reconciled but carry no journal entry, so the bank side moved without the book side. Either explain them so they post, or un-match them.",
    primary: sessionLink("Open reconciliation"),
  },
  single_item_equals_residual: {
    action: "Review this one item",
    guidance:
      "A single item accounts for the whole difference. Confirm whether it belongs to this account and period before adjusting anything else.",
    forRef: journalEntryLink,
  },
  fx_fallback_lines: {
    action: "Supply the missing exchange rates",
    guidance:
      "One or more lines were converted without a published rate for their date. A missing rate is an absence, not 1.0 — publish the rate, then re-run this statement.",
    forRef: journalEntryLink,
  },
};

export function resolveRemedy(code: string): ResidualRemedy | null {
  return RESIDUAL_REMEDIES[code] ?? null;
}
