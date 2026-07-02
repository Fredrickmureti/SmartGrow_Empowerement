/**
 * Browser-side mirror of `supabase/functions/_shared/inputRef.ts`.
 *
 * MUST stay in lock-step with the Deno copy — the payslip explainer,
 * the PDF generator, and the future drill-down resolver all rely on a
 * single, country-agnostic provenance shape (`payslip_lines.source.input_ref`).
 *
 * Kept as a physical mirror rather than a symlink because Vite and
 * Deno resolve module paths differently and a bundler trick should
 * not be the thing keeping payslip semantics consistent.
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
  code?: string;
  label?: string;
}

export type InputRef = InputRefBase & Record<string, unknown>;

/**
 * Defensive parser. Reads an unknown jsonb (the explainer often sees
 * partially-typed legacy rows) and returns a typed `InputRef` only
 * when the discriminator key is present and recognised.
 */
export function parseInputRef(source: unknown): InputRef | null {
  if (!source || typeof source !== "object") return null;
  const raw = (source as Record<string, unknown>).input_ref;
  if (!raw || typeof raw !== "object") return null;
  const ref = raw as Record<string, unknown>;
  const kind = ref.kind;
  if (typeof kind !== "string") return null;
  return ref as InputRef;
}

/**
 * Human-readable, country-agnostic source label for the explainer
 * popover. Drill-down routes (Phase 4 P4) are resolved separately.
 */
export function describeInputRef(ref: InputRef): string {
  switch (ref.kind) {
    case "contract":
      return ref.label ? String(ref.label) : "Employment contract";
    case "salary_structure":
      return ref.label ? String(ref.label) : "Salary structure";
    case "payslip_input":
    case "variable_input":
      return ref.label ? String(ref.label) : `Payroll input${ref.code ? ` · ${ref.code}` : ""}`;
    case "work_entry":
    case "attendance":
      return ref.label ? String(ref.label) : "Attendance / work entry";
    case "leave_request":
      return ref.label ? String(ref.label) : "Leave request";
    case "loan":
      return ref.label ? String(ref.label) : "Loan installment";
    case "garnishment":
      return ref.label ? String(ref.label) : "Garnishment order";
    case "statutory_rule":
      return ref.label ? String(ref.label) : "Statutory rule";
    case "retro":
      return ref.label ? String(ref.label) : "Retroactive adjustment";
    case "expense":
    case "reimbursement":
      return ref.label ? String(ref.label) : "Expense reimbursement";
    case "benefit":
      return ref.label ? String(ref.label) : "Benefit plan";
    case "termination_payout":
      return ref.label ? String(ref.label) : "Termination payout";
    case "override":
      return ref.label ? String(ref.label) : "Manual override";
    default:
      return ref.label ? String(ref.label) : String(ref.kind);
  }
}
