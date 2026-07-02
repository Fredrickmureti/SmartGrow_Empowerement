/**
 * Payroll run lifecycle — single source of truth for UI eligibility.
 *
 * Mirrors the guards inside `payroll_reverse_run_atomic` so the frontend
 * never offers an action the RPC will then reject:
 *   - is_reversal=true                → IS_REVERSAL
 *   - run_type='correction'           → INVALID_STATE
 *   - status='reversed'               → idempotent (already reversed)
 *   - status NOT IN ('posted','paid') → INVALID_STATE
 *
 * Anything that needs to ask "can the user reverse this?" MUST go through
 * `canReverseRun`. Raw `status === "paid"` checks in components are
 * forbidden — enforced by the architecture guard.
 */

export type PayrollRunLifecycle =
  | "draft"
  | "approved"
  | "posted"
  | "paid"
  | "reversed"
  | "reversal"
  | "correction";

export interface PayrollRunLike {
  status?: string | null;
  is_reversal?: boolean | null;
  run_type?: string | null;
  original_run_id?: string | null;
  reversed_at?: string | null;
}

export function getRunLifecycle(run: PayrollRunLike): PayrollRunLifecycle {
  if (run.is_reversal) return "reversal";
  if (run.run_type === "correction") return "correction";
  if (run.status === "reversed" || run.reversed_at) return "reversed";
  const s = (run.status ?? "draft") as PayrollRunLifecycle;
  return s;
}

export interface ReverseEligibility {
  allowed: boolean;
  reason?: string;
}

export function canReverseRun(run: PayrollRunLike | null | undefined): ReverseEligibility {
  if (!run) return { allowed: false, reason: "No run selected." };
  if (run.is_reversal) {
    return { allowed: false, reason: "Reversal runs cannot themselves be reversed." };
  }
  if (run.run_type === "correction") {
    return { allowed: false, reason: "Correction runs cannot be reversed through this path." };
  }
  if (run.status === "reversed" || run.reversed_at) {
    return { allowed: false, reason: "This run has already been reversed." };
  }
  if (run.status !== "posted" && run.status !== "paid") {
    return { allowed: false, reason: "Only posted or paid runs can be reversed." };
  }
  return { allowed: true };
}

export interface LineageBadge {
  label: string;
  /** Tailwind variant hint — consumed by Badge (`variant` prop). */
  variant: "outline" | "secondary" | "destructive" | "default";
}

export function getLineageBadge(run: PayrollRunLike): LineageBadge | null {
  if (run.is_reversal) return { label: "Reversal", variant: "outline" };
  if (run.status === "reversed" || run.reversed_at) {
    return { label: "Reversed", variant: "destructive" };
  }
  if (run.run_type === "correction") return { label: "Correction Δ", variant: "secondary" };
  return null;
}
