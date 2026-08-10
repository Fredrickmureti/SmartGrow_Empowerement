/**
 * Bill match vocabulary — one description of "what the matcher said".
 *
 * `match_bill_atomic` is the single matcher (see the Step 3 consolidation
 * migration): it writes exactly one `bill_match_results` row per bill and
 * raises/clears `bill_match_exceptions`. Every UI surface that talks about
 * match state — the Bills list column, the record-page panel, the peek
 * sheet — reads its labels and tone from here so the words cannot drift
 * between screens.
 */

export type BillMatchState =
  | "matched"
  | "under_billed"
  | "over_billed"
  | "price_variance"
  | "no_po";

export type BillMatchExceptionState = "none" | "pending_review" | "approved" | "rejected";

export interface BillMatchResult {
  bill_id: string;
  match_state: BillMatchState;
  exception_state: BillMatchExceptionState;
  qty_variance: number;
  price_variance: number;
  landed_cost_uplift: number;
  matched_at: string | null;
  matched_by: string | null;
  purchase_order_id: string | null;
}

type Tone = "success" | "warning" | "destructive" | "muted";

const STATE_LABEL: Record<BillMatchState, string> = {
  matched: "Matched",
  under_billed: "Under-billed",
  over_billed: "Over-billed",
  price_variance: "Price variance",
  no_po: "No PO",
};

const STATE_TONE: Record<BillMatchState, Tone> = {
  matched: "success",
  under_billed: "warning",
  over_billed: "destructive",
  price_variance: "warning",
  no_po: "muted",
};

const STATE_HELP: Record<BillMatchState, string> = {
  matched: "Billed quantities and prices agree with the receipts and the purchase order.",
  under_billed: "The supplier billed less than was received. The balance stays accrued in GRNI.",
  over_billed: "The supplier billed more than was received — do not approve without evidence.",
  price_variance: "Unit prices differ from the purchase order beyond the agreed tolerance.",
  no_po: "This bill is not backed by a purchase order, so no three-way match is possible.",
};

const EXCEPTION_LABEL: Record<BillMatchExceptionState, string> = {
  none: "No exception",
  pending_review: "Awaiting review",
  approved: "Variance accepted",
  rejected: "Variance rejected",
};

export function matchStateLabel(state: BillMatchState | null | undefined): string {
  if (!state) return "Not matched";
  return STATE_LABEL[state] ?? state;
}

export function matchStateTone(state: BillMatchState | null | undefined): Tone {
  if (!state) return "muted";
  return STATE_TONE[state] ?? "muted";
}

export function matchStateHelp(state: BillMatchState | null | undefined): string {
  if (!state) return "This bill has not been matched yet. Matching runs automatically on submit.";
  return STATE_HELP[state] ?? "";
}

export function exceptionStateLabel(state: BillMatchExceptionState | null | undefined): string {
  if (!state) return EXCEPTION_LABEL.none;
  return EXCEPTION_LABEL[state] ?? state;
}

/** True when a reviewer still has to accept or reject the variance. */
export function needsMatchReview(result: BillMatchResult | null | undefined): boolean {
  return result?.exception_state === "pending_review";
}

/** Tailwind classes for a match badge, keyed off the shared tone scale. */
export function matchToneClasses(tone: Tone): string {
  switch (tone) {
    case "success":
      return "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
    case "warning":
      return "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400";
    case "destructive":
      return "border-transparent bg-destructive/15 text-destructive";
    default:
      return "border-transparent bg-muted text-muted-foreground";
  }
}
