/**
 * Phase 4 P1.3 — payslip input lineage.
 *
 * `buildInputRef` produces a discriminated provenance pointer that the
 * payroll engine stamps onto every `payslip_lines.source.input_ref`
 * jsonb. The payslip UI, the PDF generator, and the audit drill-down
 * (P4) all read this single shape, so any change here MUST be matched
 * by an update to the consumers — and to the doc comment on
 * `public.payslip_lines.source` (migration 2026-06-29 P1.3).
 *
 * Country-agnostic. No kind here references a jurisdiction, statutory
 * code, or pack identifier. Pack rules pass their own `statutory_rule`
 * ref with the pack's `statutory_rule_id`; the engine never branches
 * on country here.
 *
 * Mirrored to the browser via `src/lib/payroll/inputRef.ts` — the two
 * files MUST stay in lock-step (same physical-mirror discipline as
 * `payslipClassifier.ts`).
 */

export type InputRefKind =
  | "contract"
  | "salary_structure"
  | "payslip_input"
  | "variable_input"
  | "work_entry"
  | "attendance"
  | "leave_request"
  | "loan"
  | "garnishment"
  | "statutory_rule"
  | "retro"
  | "expense"
  | "reimbursement"
  | "benefit"
  | "termination_payout"
  | "override";

export interface InputRefBase {
  kind: InputRefKind;
  /** Stable input code matching the emitted `payslip_lines.rule_code` when 1:1. */
  code?: string;
  /** Optional human label — surfaced verbatim in the explainer "Source" row. */
  label?: string;
}

export interface ContractInputRef extends InputRefBase {
  kind: "contract";
  contract_id?: string | null;
  component?: "basic" | "housing" | "transport" | "other";
}

export interface SalaryStructureInputRef extends InputRefBase {
  kind: "salary_structure";
  structure_id?: string | null;
  component_id?: string | null;
}

export interface PayslipInputInputRef extends InputRefBase {
  kind: "payslip_input" | "variable_input";
  input_type_id?: string | null;
  payslip_input_id?: string | null;
}

export interface WorkEntryInputRef extends InputRefBase {
  kind: "work_entry" | "attendance";
  work_entry_id?: string | null;
  date?: string | null;
  hours?: number | null;
}

export interface LeaveInputRef extends InputRefBase {
  kind: "leave_request";
  leave_request_id?: string | null;
  days?: number | null;
}

export interface LoanInputRef extends InputRefBase {
  kind: "loan";
  loan_id?: string | null;
  installment_no?: number | null;
}

export interface GarnishmentInputRef extends InputRefBase {
  kind: "garnishment";
  garnishment_id?: string | null;
}

export interface StatutoryRuleInputRef extends InputRefBase {
  kind: "statutory_rule";
  statutory_rule_id?: string | null;
  pack_version_id?: string | null;
  rule_code?: string | null;
}

export interface RetroInputRef extends InputRefBase {
  kind: "retro";
  source_payslip_id?: string | null;
  source_run_id?: string | null;
}

export interface ExpenseInputRef extends InputRefBase {
  kind: "expense" | "reimbursement";
  expense_id?: string | null;
}

export interface BenefitInputRef extends InputRefBase {
  kind: "benefit";
  benefit_id?: string | null;
  plan_id?: string | null;
}

export interface TerminationPayoutInputRef extends InputRefBase {
  kind: "termination_payout";
  pending_payout_id?: string | null;
  days?: number | null;
}

export interface OverrideInputRef extends InputRefBase {
  kind: "override";
  reason?: string | null;
}

export type InputRef =
  | ContractInputRef
  | SalaryStructureInputRef
  | PayslipInputInputRef
  | WorkEntryInputRef
  | LeaveInputRef
  | LoanInputRef
  | GarnishmentInputRef
  | StatutoryRuleInputRef
  | RetroInputRef
  | ExpenseInputRef
  | BenefitInputRef
  | TerminationPayoutInputRef
  | OverrideInputRef;

/**
 * Build a typed input_ref jsonb. Pure: no IO, no engine state — safe
 * to call from any emitter. Strips undefined keys so the jsonb stays
 * compact and stable for hash-based audits.
 */
export function buildInputRef<K extends InputRef>(ref: K): K {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ref)) {
    if (v !== undefined) out[k] = v;
  }
  return out as K;
}

/**
 * Merge an input_ref into an engine-authored `source` jsonb without
 * clobbering existing bracket/explanation keys.
 */
export function withInputRef(
  source: Record<string, unknown> | null | undefined,
  ref: InputRef,
): Record<string, unknown> {
  return { ...(source || {}), input_ref: buildInputRef(ref) };
}
