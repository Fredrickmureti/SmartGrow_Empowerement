/**
 * State-driven options for the GovernedEntityPicker.
 *
 * Each governed entity_type maps to a small query against its underlying
 * table, scoped to the active organization and filtered to states where
 * approval is still meaningful (drafts, submitted, pending_approval).
 * The returned `subject_user_id` is what the Self-Action Override dialog
 * uses to auto-derive the subject for `*_self_benefit` actions.
 *
 * Pickers intentionally cap at 50 recent rows — the override flow is
 * for emergency break-glass, not bulk admin browsing.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { SelfActionEntityType } from "@/lib/governance/selfActionCatalogue";

export interface GovernedEntityOption {
  id: string;
  label: string;
  hint?: string;
  subject_user_id: string | null;
}

const LIMIT = 50;

type Loader = (orgId: string) => Promise<GovernedEntityOption[]>;

const fmtMoney = (n: number | null | undefined, ccy: string | null | undefined) =>
  n == null ? "" : `${ccy ?? ""} ${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`.trim();

const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString() : "");

/** Lookup: employee_id → user_id (for from_entity subject derivation). */
async function resolveEmployeeUserIds(employeeIds: string[]): Promise<Map<string, string | null>> {
  const ids = Array.from(new Set(employeeIds.filter(Boolean)));
  if (ids.length === 0) return new Map();
  const { data } = await supabase.from("v_employees_canonical").select("id, user_id").in("id", ids);
  const m = new Map<string, string | null>();
  (data ?? []).forEach((r: any) => m.set(r.id, r.user_id));
  return m;
}

const LOADERS: Record<SelfActionEntityType, Loader> = {
  bank_account: async (orgId) => {
    // Bank accounts aren't a workflow entity per se, but governance can scope
    // approvals to specific accounts (e.g. "approve any disbursement from
    // Operating USD"). We surface the active accounts in the org.
    const { data, error } = await supabase
      .from("bank_accounts")
      .select("id, account_name, account_number, currency, is_active")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("account_name")
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.account_name ?? `Account ${r.id.slice(0, 8)}`,
      hint: `${r.account_number ?? ""} • ${r.currency ?? ""}`.trim(),
      subject_user_id: null,
    }));
  },
  payroll_run: async (orgId) => {
    const { data, error } = await supabase
      .from("payroll_runs")
      .select("id, payroll_number, pay_period_start, pay_period_end, total_net, currency, status, created_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "calculated", "submitted", "pending_approval"])
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `${r.payroll_number ?? "Run"} — ${fmtDate(r.pay_period_start)}→${fmtDate(r.pay_period_end)}`,
      hint: `${fmtMoney(r.total_net, r.currency)} • ${r.status}`,
      subject_user_id: r.created_by ?? null,
    }));
  },
  payroll_payment_batch: async (orgId) => {
    // Disbursement batches whose lifecycle is still actionable (anything
    // before the terminal `paid|cancelled|reversed` states). The override
    // dialog needs these for break-glass approve/lock/transmit/cancel/etc.
    const { data, error } = await supabase
      .from("payroll_payment_batches")
      .select("id, batch_number, status, total_amount, payment_date, created_by")
      .eq("organization_id", orgId)
      .not("status", "in", "(paid,cancelled,reversed)")
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `${r.batch_number ?? `Batch ${String(r.id).slice(0, 8)}`} — ${r.status}`,
      hint: `${fmtMoney(r.total_amount, null)} ${r.payment_date ? `• ${fmtDate(r.payment_date)}` : ""}`.trim(),
      subject_user_id: r.created_by ?? null,
    }));
  },
  leave_request: async (orgId) => {
    const { data, error } = await supabase
      .from("leave_requests")
      .select("id, employee_id, start_date, end_date, status")
      .eq("organization_id", orgId)
      .in("status", ["pending", "submitted", "approved_l1"])
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    const map = await resolveEmployeeUserIds((data ?? []).map((r: any) => r.employee_id));
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `Leave ${fmtDate(r.start_date)}→${fmtDate(r.end_date)}`,
      hint: r.status,
      subject_user_id: map.get(r.employee_id) ?? null,
    }));
  },
  timesheet_submission: async (orgId) => {
    const { data, error } = await supabase
      .from("timesheet_submissions")
      .select("id, employee_id, period_start, period_end, status, total_hours")
      .eq("organization_id", orgId)
      .in("status", ["submitted", "pending_approval"])
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    const map = await resolveEmployeeUserIds((data ?? []).map((r: any) => r.employee_id));
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `Timesheet ${fmtDate(r.period_start)}→${fmtDate(r.period_end)}`,
      hint: `${r.total_hours ?? 0} h • ${r.status}`,
      subject_user_id: map.get(r.employee_id) ?? null,
    }));
  },
  employee_loan: async (orgId) => {
    const { data, error } = await supabase
      .from("employee_loans")
      .select("id, employee_id, status, start_date, description, created_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval"])
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    const map = await resolveEmployeeUserIds((data ?? []).map((r: any) => r.employee_id));
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.description ?? `Loan ${fmtDate(r.start_date)}`,
      hint: r.status,
      // For loan.approve_self_benefit, the beneficiary is the entity's employee.
      subject_user_id: map.get(r.employee_id) ?? null,
    }));
  },
  employee_compensation_change: async (orgId) => {
    const { data, error } = await supabase
      .from("employee_compensation_history")
      .select("id, employee_id, created_by")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    const map = await resolveEmployeeUserIds((data ?? []).map((r: any) => r.employee_id));
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `Compensation change ${r.id.slice(0, 8)}`,
      hint: undefined,
      subject_user_id: map.get(r.employee_id) ?? null,
    }));
  },
  employee_contract: async (orgId) => {
    const { data, error } = await supabase
      .from("employee_contracts")
      .select("id, employee_id, status, start_date, end_date")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval"])
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    const map = await resolveEmployeeUserIds((data ?? []).map((r: any) => r.employee_id));
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `Contract ${fmtDate(r.start_date)}→${fmtDate(r.end_date)}`,
      hint: r.status,
      subject_user_id: map.get(r.employee_id) ?? null,
    }));
  },
  bill: async (orgId) => {
    const { data, error } = await supabase
      .from("bills")
      .select("id, bill_number, total, currency, status, created_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval"] as any)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.bill_number ?? `Bill ${r.id.slice(0, 8)}`,
      hint: `${fmtMoney(r.total, r.currency)} • ${r.status}`,
      subject_user_id: r.created_by ?? null,
    }));
  },
  bill_payment: async (orgId) => {
    const { data, error } = await supabase
      .from("bill_payments")
      .select("id, reference, amount, created_by")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.reference ?? `Payment ${r.id.slice(0, 8)}`,
      hint: fmtMoney(r.amount, null),
      subject_user_id: r.created_by ?? null,
    }));
  },
  payment: async (orgId) => {
    const { data, error } = await supabase
      .from("payments")
      .select("id, reference, amount, status, created_by")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.reference ?? `Payment ${r.id.slice(0, 8)}`,
      hint: `${fmtMoney(r.amount, null)} • ${r.status ?? ""}`,
      subject_user_id: r.created_by ?? null,
    }));
  },
  journal_entry: async (orgId) => {
    const { data, error } = await supabase
      .from("journal_entries")
      .select("id, entry_number, entry_date, description, status, created_by, currency")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval"])
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `${r.entry_number ?? "JE"} — ${fmtDate(r.entry_date)}`,
      hint: r.description ?? r.status,
      subject_user_id: r.created_by ?? null,
    }));
  },
  customer_refund: async (orgId) => {
    const { data, error } = await supabase
      .from("customer_refunds")
      .select("id, reference, amount, currency, status, created_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval"])
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.reference ?? `Refund ${r.id.slice(0, 8)}`,
      hint: `${fmtMoney(r.amount, r.currency)} • ${r.status}`,
      subject_user_id: r.created_by ?? null,
    }));
  },
  purchase_requisition: async (orgId) => {
    const { data, error } = await supabase
      .from("purchase_requisitions")
      .select("id, requisition_number, estimated_total, currency, status, requester_id, submitted_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted"] as any)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.requisition_number ?? `Requisition ${r.id.slice(0, 8)}`,
      hint: `${fmtMoney(r.estimated_total, r.currency)} • ${r.status}`,
      subject_user_id: r.submitted_by ?? r.requester_id ?? null,
    }));
  },
  rfq: async (orgId) => {
    const { data, error } = await supabase
      .from("rfqs")
      .select("id, rfq_number, currency, status, submitted_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "pending_approval", "sent", "responses_received", "under_evaluation"] as any)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.rfq_number ?? `RFQ ${r.id.slice(0, 8)}`,
      hint: `${r.currency ?? ""} • ${r.status}`,
      subject_user_id: r.submitted_by ?? null,
    }));
  },
  purchase_order: async (orgId) => {
    const { data, error } = await supabase
      .from("purchase_orders")
      .select("id, po_number, total, currency, status, created_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval"] as any)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.po_number ?? `PO ${r.id.slice(0, 8)}`,
      hint: `${fmtMoney(r.total, r.currency)} • ${r.status}`,
      subject_user_id: r.created_by ?? null,
    }));
  },
  vendor_credit_note: async (orgId) => {
    const { data, error } = await supabase
      .from("vendor_credit_notes")
      .select("id, total, currency, status, created_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval"] as any)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `Vendor credit ${r.id.slice(0, 8)}`,
      hint: `${fmtMoney(r.total, r.currency)} • ${r.status}`,
      subject_user_id: r.created_by ?? null,
    }));
  },
  credit_note: async (orgId) => {
    const { data, error } = await supabase
      .from("credit_notes")
      .select("id, total, currency, status, created_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval"] as any)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `Credit note ${r.id.slice(0, 8)}`,
      hint: `${fmtMoney(r.total, r.currency)} • ${r.status}`,
      subject_user_id: r.created_by ?? null,
    }));
  },
  stock_adjustment: async (orgId) => {
    const { data, error } = await supabase
      .from("stock_adjustments")
      .select("id, status, notes, created_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval"] as any)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `Adjustment ${r.id.slice(0, 8)}`,
      hint: r.notes ?? r.status,
      subject_user_id: r.created_by ?? null,
    }));
  },
  physical_count: async (orgId) => {
    const { data, error } = await supabase
      .from("physical_counts")
      .select("id, count_number, state, created_by")
      .eq("organization_id", orgId)
      .in("state", ["counting", "in_review"] as any)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.count_number ?? `Count ${r.id.slice(0, 8)}`,
      hint: r.state,
      subject_user_id: r.created_by ?? null,
    }));
  },
  stock_transfer: async (orgId) => {
    const { data, error } = await supabase
      .from("stock_transfers")
      .select("id, status, notes")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval", "in_transit"])
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `Transfer ${r.id.slice(0, 8)}`,
      hint: r.notes ?? r.status,
      subject_user_id: null,
    }));
  },
  expense: async (orgId) => {
    const { data, error } = await supabase
      .from("expenses")
      .select("id, employee_id, expense_date, amount, currency, status, description, created_by")
      .eq("organization_id", orgId)
      .in("status", ["draft", "submitted", "pending_approval"] as any)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw error;
    const map = await resolveEmployeeUserIds(
      (data ?? []).map((r: any) => r.employee_id).filter(Boolean),
    );
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: r.description ?? `Expense ${fmtDate(r.expense_date)}`,
      hint: `${fmtMoney(r.amount, r.currency)} • ${r.status}`,
      // self_benefit subject derives from the employee record; plain
      // expense.approve will instead read subject = actor at the dialog layer.
      subject_user_id: r.employee_id ? map.get(r.employee_id) ?? null : r.created_by ?? null,
    }));
  },
  payroll_run_loan_skip_override: async (orgId) => {
    // Loan-skip overrides aren't browseable workflow rows — the picker
    // here exists only so the governance catalogue stays type-complete.
    // Surface recent override events scoped to the org for context.
    const { data, error } = await supabase
      .from("payroll_run_loan_skip_overrides")
      .select("id, payroll_run_id, employee_id, reason, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) return [];
    const map = await resolveEmployeeUserIds(
      (data ?? []).map((r: any) => r.employee_id).filter(Boolean),
    );
    return (data ?? []).map((r: any) => ({
      id: r.id,
      label: `Loan skip ${fmtDate(r.created_at)}`,
      hint: r.reason ?? "",
      subject_user_id: r.employee_id ? map.get(r.employee_id) ?? null : null,
    }));
  },
};

export function useGovernedEntityOptions(
  organizationId: string | null | undefined,
  entityType: SelfActionEntityType | null,
) {
  return useQuery({
    queryKey: ["governed-entity-options", organizationId, entityType],
    enabled: !!organizationId && !!entityType,
    staleTime: 15_000,
    queryFn: async (): Promise<GovernedEntityOption[]> => {
      if (!organizationId || !entityType) return [];
      const loader = LOADERS[entityType];
      return loader(organizationId);
    },
  });
}
