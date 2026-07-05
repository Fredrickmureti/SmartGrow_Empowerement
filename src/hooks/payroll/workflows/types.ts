/**
 * Shared shapes for the six parallel-workflow hooks (plan §Phase 5a).
 *
 * Each hook returns a `WorkflowSnapshot` that a drawer or the WorkflowStrip
 * can render without knowing anything workflow-specific. Preconditions are
 * a small, ordered, satisfied/unsatisfied list — never a free-form string —
 * so the UI can render them uniformly and so tests can assert on codes.
 */

export type WorkflowKey =
  | "posting"
  | "payment"
  | "bank_file"
  | "returns"
  | "remittance"
  | "period_close";

export interface WorkflowPrecondition {
  code: string;
  message: string;
  satisfied: boolean;
}

export interface WorkflowSnapshot<S extends string = string> {
  workflow: WorkflowKey;
  /** Terminal / active state of this workflow (e.g. "posted", "fully_paid"). */
  state: S;
  /** Whether the next transition can happen right now. */
  canAdvance: boolean;
  /** Ordered preconditions surfaced to the user. */
  preconditions: WorkflowPrecondition[];
  /** Last actor id / timestamp (nullable). Rendered as tooltip metadata. */
  lastActor: { userId: string | null; at: string | null } | null;
  /** Loading / error state for the underlying reads. */
  loading: boolean;
  error: unknown;
}