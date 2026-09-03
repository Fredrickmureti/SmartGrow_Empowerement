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
      .in("status", ["draft", "submitted", "pending_approval"] as any)
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
