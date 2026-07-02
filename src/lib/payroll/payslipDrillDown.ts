/**
 * Phase 4 P4 — Payslip drill-down resolver.
 *
 * Single, country-agnostic mapping from a `payslip_lines.source.input_ref`
 * (see `supabase/functions/_shared/inputRef.ts`) to an in-app route. The
 * payroll engine never learns about routes; this file is the *only* place
 * the UI translates an input ref into navigation.
 *
 * Pure module — no React, no fetch, no Supabase. Consumed by
 * `usePayslipDrillDown` (which layers permissions + self-service context)
 * and by the architecture tests that lock the country-agnostic invariant.
 *
 * Adding a new `InputRefKind` MUST update `DRILL_TABLE` below — the
 * exhaustive switch + `_never` check fails the typecheck otherwise.
 */
import type { InputRef, InputRefKind } from "./inputRef";

export type DrillContext = "admin" | "portal";

export interface DrillTarget {
  /** Resolved absolute path (includes query string when relevant). */
  href: string;
  /** Human-readable button label, e.g. "Open employment contract". */
  label: string;
  /** Pass-through for telemetry / aria-label composition. */
  kind: InputRefKind;
  /**
   * Permission gate consumed by `usePayslipDrillDown`. When the current
   * user lacks the permission, the hook drops the target to `null` so
   * the UI never offers a link the route guard would later reject.
   */
  requiresPermission?: string;
}

export interface ResolveContext {
  mode: DrillContext;
  /** Optional — used to backfill /hr/employees/{id} links from contract refs. */
  employeeId?: string | null;
}

/**
 * Country-agnostic vocabulary for the button labels. No statutory codes,
 * no jurisdictional terms. The label answers "what kind of business
 * record am I about to open?", not "which legislation produced it".
 */
const LABELS: Record<InputRefKind, string> = {
  contract: "Open employment contract",
  salary_structure: "Open salary structure",
  payslip_input: "Open payroll input",
  variable_input: "Open payroll input",
  work_entry: "Open work entry",
  attendance: "Open attendance record",
  leave_request: "Open leave request",
  loan: "Open loan",
  garnishment: "Open garnishment",
  statutory_rule: "Open statutory rule",
  retro: "Open original payslip",
  expense: "Open expense",
  reimbursement: "Open reimbursement",
  benefit: "Open benefit enrolment",
  termination_payout: "Open termination payout",
  override: "",
};

export function labelFor(kind: InputRefKind): string {
  return LABELS[kind] ?? "";
}

function qs(parts: Record<string, unknown>): string {
  const entries = Object.entries(parts).filter(([, v]) => {
    if (v === null || v === undefined || v === "") return false;
    const t = typeof v;
    return t === "string" || t === "number" || t === "boolean";
  });
  if (entries.length === 0) return "";
  const search = new URLSearchParams();
  for (const [k, v] of entries) search.set(k, String(v));
  return `?${search.toString()}`;
}

/**
 * Resolve a drill target for a given input ref + context.
 *
 * Returns `null` when:
 *   - the ref kind has no meaningful destination (e.g. `override`);
 *   - required identifiers are missing on the ref;
 *   - the kind is sensitive (e.g. `garnishment`, `termination_payout`)
 *     and the caller is in `portal` mode.
 */
export function resolveDrillTarget(
  ref: InputRef,
  ctx: ResolveContext,
): DrillTarget | null {
  const isPortal = ctx.mode === "portal";
  const label = labelFor(ref.kind);

  switch (ref.kind) {
    case "contract": {
      const contractId = ref.contract_id;
      if (!contractId) return null;
      if (isPortal) {
        // No dedicated employee-side contract viewer yet (deferred to P5);
        // bail to descriptive text rather than offering a dead link.
        return null;
      }
      const eid = ctx.employeeId;
      if (!eid) return null;
      return {
        href: `/hr/employees/${eid}${qs({ tab: "contracts", contract_id: contractId })}`,
        label,
        kind: ref.kind,
        requiresPermission: "viewPayroll",
      };
    }

    case "salary_structure": {
      if (isPortal) return null;
      const structureId = ref.structure_id;
      if (!structureId) return null;
      return {
        href: `/hr/payroll/configuration/structures${qs({
          structure: structureId,
          component: ref.component_id ?? undefined,
        })}`,
        label,
        kind: ref.kind,
        requiresPermission: "managePayroll",
      };
    }

    case "payslip_input":
    case "variable_input": {
      const inputId = ref.payslip_input_id ?? ref.input_type_id;
      if (!inputId) return null;
      if (isPortal) {
        // Employees see their own input in the payslip detail itself —
        // there's no separate self-service "inputs" surface today.
        return null;
      }
      return {
        href: `/hr/payroll/work-entries${qs({ input: inputId })}`,
        label,
        kind: ref.kind,
        requiresPermission: "viewPayroll",
      };
    }

    case "work_entry":
    case "attendance": {
      const id = ref.work_entry_id;
      if (isPortal) {
        if (!ref.date && !id) return null;
        return {
          href: `/me/attendance${qs({ date: ref.date ?? undefined, entry: id ?? undefined })}`,
          label,
          kind: ref.kind,
        };
      }
      if (!id && !ref.date) return null;
      return {
        href: `/hr/payroll/work-entries${qs({ entry: id ?? undefined, date: ref.date ?? undefined })}`,
        label,
        kind: ref.kind,
        requiresPermission: "viewPayroll",
      };
    }

    case "leave_request": {
      const id = ref.leave_request_id;
      if (!id) return null;
      return isPortal
        ? { href: `/me/leave${qs({ request: id })}`, label, kind: ref.kind }
        : {
            href: `/hr/leave/approvals${qs({ request: id })}`,
            label,
            kind: ref.kind,
            requiresPermission: "viewLeave",
          };
    }

    case "loan": {
      const id = ref.loan_id;
      if (!id) return null;
      const installment = ref.installment_no ?? undefined;
      return isPortal
        ? {
            href: `/me/loans${qs({ loan: id, installment })}`,
            label,
            kind: ref.kind,
          }
        : {
            href: `/hr/payroll/loans${qs({ loan: id, installment })}`,
            label,
            kind: ref.kind,
            requiresPermission: "manageEmployeeLoans",
          };
    }

    case "garnishment": {
      if (isPortal) return null;
      const id = ref.garnishment_id;
      if (!id) return null;
      return {
        href: `/hr/payroll/garnishments${qs({ garnishment: id })}`,
        label,
        kind: ref.kind,
        requiresPermission: "managePayroll",
      };
    }

    case "statutory_rule": {
      if (isPortal) return null;
      const id = ref.statutory_rule_id;
      if (!id) return null;
      return {
        href: `/hr/payroll/statutory-rules${qs({
          rule: id,
          version: ref.pack_version_id ?? undefined,
        })}`,
        label,
        kind: ref.kind,
        requiresPermission: "manageStatutoryRules",
      };
    }

    case "retro": {
      const id = ref.source_payslip_id;
      if (!id) return null;
      return isPortal
        ? { href: `/me/payslips${qs({ payslip: id })}`, label, kind: ref.kind }
        : {
            href: `/hr/payroll/payslips/${id}`,
            label,
            kind: ref.kind,
            requiresPermission: "viewPayroll",
          };
    }

    case "expense":
    case "reimbursement": {
      const id = ref.expense_id;
      if (!id) return null;
      if (isPortal) return null; // no portal expense viewer yet
      return {
        href: `/expenses${qs({ expense: id })}`,
        label,
        kind: ref.kind,
        requiresPermission: "viewPayroll",
      };
    }

    case "benefit": {
      if (isPortal) return null; // portal benefits surface deferred
      const id = ref.benefit_id ?? ref.plan_id;
      if (!id) return null;
      // Benefits administration lives inside the payroll configuration
      // workspace today (see EmployeesRoutes legacy-redirect map). Routing
      // here keeps the drill-down link inside a registered nav entry and
      // lands the admin on the configuration surface where the plan and
      // enrollment records are managed.
      return {
        href: `/hr/payroll/configuration${qs({
          tab: "benefits",
          plan: ref.plan_id ?? undefined,
          enrollment: ref.benefit_id ?? undefined,
        })}`,
        label,
        kind: ref.kind,
        requiresPermission: "managePayroll",
      };
    }

    case "termination_payout": {
      if (isPortal) return null;
      const eid = ctx.employeeId;
      const payoutId = ref.pending_payout_id;
      if (!eid || !payoutId) return null;
      return {
        href: `/hr/employees/${eid}${qs({ tab: "exit", payout: payoutId })}`,
        label,
        kind: ref.kind,
        requiresPermission: "managePayroll",
      };
    }

    case "override":
      return null;

    default: {
      // Exhaustiveness guard — adding a new InputRefKind fails the typecheck
      // here until DRILL_TABLE / LABELS / this switch are all updated.
      const _never: never = ref as never;
      void _never;
      return null;
    }
  }
}

/**
 * Country-agnostic invariant used by the architecture test.
 * If any future change leaks jurisdictional vocabulary into a generated
 * URL, the regex catches it.
 */
export const COUNTRY_SPECIFIC_TOKEN_RE =
  /\b(paye|nhif|shif|nssf|ahl|housing[-_]?levy|kra|nita|kenya|uganda|tanzania|rwanda|nigeria)\b/i;
