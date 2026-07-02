/**
 * Exit clearance (offboarding) hook.
 *
 * Drives `employee_exit_clearance` + `employee_exit_clearance_items` so HR
 * has a department-by-department signoff trail before an employee is
 * deactivated. Surfaces blockers (outstanding loans, unreturned company
 * assets) so the termination dialog can prevent premature deactivation.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface ExitClearance {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  initiated_by: string | null;
  initiated_at: string;
  last_working_day: string;
  exit_type: string;
  reason: string | null;
  status: "in_progress" | "completed" | "cancelled";
  final_pay_run_id: string | null;
  certificate_url: string | null;
  completed_at: string | null;
}

export interface ExitClearanceItem {
  id: string;
  clearance_id: string;
  department: string;
  task: string;
  assignee_user_id: string | null;
  status: "pending" | "completed" | "blocked" | "waived";
  signed_by: string | null;
  signed_at: string | null;
  notes: string | null;
  sort_order: number;
  is_blocking: boolean;
}

export interface ExitBlockers {
  outstandingLoans: number;
  outstandingLoanBalance: number;
  assignedAssets: number;
}

/**
 * Default offboarding checklist seeded when HR initiates clearance. Each row
 * maps to a department that must sign off before the employee is fully
 * cleared. Edit cautiously — order is preserved via `sort_order`.
 */
const DEFAULT_ITEMS: Array<{ department: string; task: string; is_blocking: boolean }> = [
  { department: "IT", task: "Revoke system access & email", is_blocking: true },
  { department: "IT", task: "Recover laptop, phone & peripherals", is_blocking: true },
  { department: "Admin", task: "Recover ID card, keys & access badges", is_blocking: true },
  { department: "Finance", task: "Settle outstanding loans & advances", is_blocking: true },
  { department: "Finance", task: "Process final pay & leave encashment", is_blocking: true },
  { department: "HR", task: "Conduct exit interview", is_blocking: false },
  { department: "HR", task: "Terminate benefits & insurance", is_blocking: true },
  { department: "HR", task: "Issue certificate of service", is_blocking: false },
  { department: "Manager", task: "Knowledge transfer & handover", is_blocking: true },
  { department: "Manager", task: "Final timesheet approved", is_blocking: false },
];

export function useEmployeeBlockers(employeeId: string | null | undefined) {
  const [blockers, setBlockers] = useState<ExitBlockers>({
    outstandingLoans: 0,
    outstandingLoanBalance: 0,
    assignedAssets: 0,
  });
  const [loading, setLoading] = useState(false);

  const fetchBlockers = useCallback(async () => {
    if (!employeeId) return;
    setLoading(true);
    try {
      const [{ data: loans }, { data: assets }] = await Promise.all([
        supabase
          .from("employee_loans")
          .select("outstanding_balance")
          .eq("employee_id", employeeId)
          .in("status", ["active", "suspended"]),
        supabase
          .from("fixed_assets")
          .select("id")
          .eq("assigned_to_employee_id", employeeId)
          .is("returned_at", null),
      ]);
      setBlockers({
        outstandingLoans: loans?.length ?? 0,
        outstandingLoanBalance:
          loans?.reduce((sum, l) => sum + Number(l.outstanding_balance || 0), 0) ?? 0,
        assignedAssets: assets?.length ?? 0,
      });
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    fetchBlockers();
  }, [fetchBlockers]);

  return { blockers, loading, refresh: fetchBlockers };
}

export function useExitClearance(employeeId: string | null | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const [clearance, setClearance] = useState<ExitClearance | null>(null);
  const [items, setItems] = useState<ExitClearanceItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchClearance = useCallback(async () => {
    if (!employeeId || !currentOrg?.id) return;
    setLoading(true);
    try {
      const { data: existing } = await supabase
        .from("employee_exit_clearance")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("employee_id", employeeId)
        .order("initiated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      setClearance((existing as ExitClearance | null) ?? null);
      if (existing) {
        const { data: rows } = await supabase
          .from("employee_exit_clearance_items")
          .select("*")
          .eq("clearance_id", existing.id)
          .order("sort_order", { ascending: true });
        setItems((rows ?? []) as ExitClearanceItem[]);
      } else {
        setItems([]);
      }
    } finally {
      setLoading(false);
    }
  }, [employeeId, currentOrg?.id]);

  useEffect(() => {
    fetchClearance();
  }, [fetchClearance]);

  /** Create a clearance record + seed default items if one does not already exist. */
  const ensureClearance = useCallback(
    async (opts: { lastWorkingDay: string; exitType: string; reason?: string }) => {
      if (!employeeId || !currentOrg?.id) return null;
      if (clearance && clearance.status === "in_progress") return clearance;

      const { data: created, error } = await supabase
        .from("employee_exit_clearance")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id ?? null,
          employee_id: employeeId,
          initiated_by: user?.id ?? null,
          last_working_day: opts.lastWorkingDay,
          exit_type: opts.exitType,
          reason: opts.reason ?? null,
          status: "in_progress",
        })
        .select("*")
        .single();
      if (error || !created) {
        toast.error("Failed to initiate clearance", { description: error?.message });
        return null;
      }

      const seed = DEFAULT_ITEMS.map((row, idx) => ({
        clearance_id: created.id,
        department: row.department,
        task: row.task,
        is_blocking: row.is_blocking,
        sort_order: idx,
        status: "pending" as const,
      }));
      const { error: itemsErr } = await supabase
        .from("employee_exit_clearance_items")
        .insert(seed);
      if (itemsErr) {
        toast.error("Clearance created but items failed", { description: itemsErr.message });
      }
      await fetchClearance();
      return created as ExitClearance;
    },
    [employeeId, currentOrg?.id, currentBusiness?.id, user?.id, clearance, fetchClearance],
  );

  const signItem = useCallback(
    async (itemId: string, opts?: { notes?: string; status?: ExitClearanceItem["status"] }) => {
      const status = opts?.status ?? "completed";
      const { error } = await supabase
        .from("employee_exit_clearance_items")
        .update({
          status,
          signed_by: user?.id ?? null,
          signed_at: new Date().toISOString(),
          notes: opts?.notes ?? null,
        })
        .eq("id", itemId);
      if (error) {
        toast.error("Failed to update task", { description: error.message });
        return false;
      }
      await fetchClearance();
      return true;
    },
    [user?.id, fetchClearance],
  );

  const reopenItem = useCallback(
    async (itemId: string) => {
      const { error } = await supabase
        .from("employee_exit_clearance_items")
        .update({ status: "pending", signed_by: null, signed_at: null })
        .eq("id", itemId);
      if (error) {
        toast.error("Failed to reopen task", { description: error.message });
        return false;
      }
      await fetchClearance();
      return true;
    },
    [fetchClearance],
  );

  /**
   * Mark the clearance as completed. A DB trigger then:
   *   - blocks completion if the employee has unsettled loans, and
   *   - auto-creates a draft final-settlement payroll run + links `final_pay_run_id`.
   * Callers should refresh the employee record afterwards so payroll picks the run up.
   */
  const completeClearance = useCallback(async () => {
    if (!clearance?.id) return false;
    const { error } = await supabase
      .from("employee_exit_clearance")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", clearance.id);
    if (error) {
      toast.error("Cannot complete clearance", { description: error.message });
      return false;
    }
    toast.success("Clearance completed — final settlement payroll run created in draft.");
    await fetchClearance();
    return true;
  }, [clearance?.id, fetchClearance]);

  const allBlockingSigned = items
    .filter((i) => i.is_blocking)
    .every((i) => i.status === "completed" || i.status === "waived");

  return {
    clearance,
    items,
    loading,
    ensureClearance,
    signItem,
    reopenItem,
    completeClearance,
    refresh: fetchClearance,
    allBlockingSigned,
  };
}
