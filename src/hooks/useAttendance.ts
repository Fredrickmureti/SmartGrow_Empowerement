import { normalizeError } from "@/services/resilience";
/**
 * Attendance Hook — RPC-only.
 *
 * Every write goes through a SECURITY DEFINER RPC. The client never
 * touches `attendance` columns directly. RLS still applies on reads.
 *
 * Reads are branch-scoped via applyBranchFilter and include branch_id
 * in the queryKey so the cache partitions correctly per branch.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranches } from "./useBranches";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { assertHrScope } from "@/lib/hr/scopingAssertions";
import { applyBranchFilter } from "@/lib/branchScope";
import { todayInBusinessTz } from "@/lib/businessTime";
import { dispatchApprovalNotification } from "@/lib/hr/approvalNotifications";

export interface AttendanceRecord {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  employee_id: string;
  attendance_date: string;
  clock_in: string | null;
  clock_out: string | null;
  worked_hours: number | null;
  overtime_hours: number | null;
  break_duration_minutes: number | null;
  status: string;
  notes: string | null;
  clock_in_method: string | null;
  clock_in_location: Record<string, any> | null;
  clock_out_location: Record<string, any> | null;
  approved_by: string | null;
  approved_at: string | null;
  correction_status: string;
  correction_reason: string | null;
  corrected_by: string | null;
  corrected_at: string | null;
  original_clock_in: string | null;
  original_clock_out: string | null;
  is_locked: boolean;
  locked_by_payroll_run_id: string | null;
  expected_hours: number | null;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  attendance_date_end: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  employee?: {
    id: string;
    first_name: string;
    last_name: string;
    employee_number: string;
    department: string | null;
    /** Current primary branch (from v_employees_canonical). */
    primary_branch_id: string | null;
    /** All open branch assignments. Empty = HQ/remote. */
    branch_ids: string[] | null;
  };
}

function mapRpcError(err: any): Error {
  const msg = err?.message || "Operation failed";
  if (msg.includes("open attendance session") || msg.includes("already")) {
    return new Error("You already have an active session. Please clock out first.");
  }
  if (msg.includes("on approved leave")) {
    return new Error("Cannot clock in on an approved leave day.");
  }
  if (msg.includes("locked")) {
    return new Error("This record is locked by payroll and cannot be edited.");
  }
  if (msg.includes("permission")) {
    return new Error("You don't have permission for this action.");
  }
  return new Error(msg);
}

export function useAttendance(dateRange?: { from: string; to: string }) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const today = todayInBusinessTz(currentBusiness?.timezone);
  const from = dateRange?.from || today;
  const to = dateRange?.to || today;

  const { data: records = [], isLoading } = useQuery({
    queryKey: ["attendance", currentOrg?.id, currentBusiness?.id, currentBranch?.id, from, to],
    queryFn: async () => {
      assertHrScope({
        hook: "useAttendance",
        orgId: currentOrg?.id,
        businessId: currentBusiness?.id,
        businessRequired: true,
      });
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      let query = supabase
        .from("attendance")
        .select(
          "*, employee:v_employees_canonical(id, first_name, last_name, employee_number, department, primary_branch_id, branch_ids)"
        )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .gte("attendance_date", from)
        .lte("attendance_date", to)
        .order("attendance_date", { ascending: false })
        .order("clock_in", { ascending: false });

      query = applyBranchFilter(query, currentBranch?.id);

      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as unknown as AttendanceRecord[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  /**
   * Live presence — open sessions regardless of attendance_date.
   * Odoo-style: an employee is "present now" iff they have a session with
   * clock_in set and clock_out NULL. This MUST be independent of the
   * dashboard's date range, otherwise a shift that started before midnight
   * disappears from "Checked in now" as soon as the day rolls over.
   */
  const { data: openSessions = [] } = useQuery({
    queryKey: ["attendance-open-sessions", currentOrg?.id, currentBusiness?.id, currentBranch?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      let q: any = (supabase as any)
        .from("attendance")
        .select(
          "id, employee_id, branch_id, attendance_date, clock_in, employee:v_employees_canonical(id, first_name, last_name, employee_number, primary_branch_id, branch_ids)"
        )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .is("clock_out", null)
        .not("clock_in", "is", null)
        .order("clock_in", { ascending: false });
      q = applyBranchFilter(q, currentBranch?.id);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as any[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    refetchInterval: 60_000,
  });


  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["attendance"] });
    queryClient.invalidateQueries({ queryKey: ["attendance-status"] });
    queryClient.invalidateQueries({ queryKey: ["my-attendance"] });
    queryClient.invalidateQueries({ queryKey: ["attendance-corrections"] });
  };

  const clockIn = useMutation({
    mutationFn: async (employeeId: string) => {
      if (!user) throw new Error("Not authenticated");
      const { data, error } = await supabase.rpc("attendance_clock_in", {
        _employee_id: employeeId,
        _branch_id: currentBranch?.id ?? null,
        _source: "web",
        _location: null,
      });
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: () => {
      toast.success("Clocked in successfully");
      invalidate();
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const clockOut = useMutation({
    mutationFn: async (employeeId: string) => {
      const { data, error } = await supabase.rpc("attendance_clock_out", {
        _employee_id: employeeId,
        _location: null,
      });
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: () => {
      toast.success("Clocked out successfully");
      invalidate();
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const createAttendance = useMutation({
    mutationFn: async (record: {
      employee_id: string;
      attendance_date: string;
      clock_in: string | null;
      clock_out: string | null;
      status: string;
      notes: string | null;
      branch_id?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("attendance_admin_create", {
        _employee_id: record.employee_id,
        _date: record.attendance_date,
        _clock_in: record.clock_in,
        _clock_out: record.clock_out,
        _status: record.status,
        _notes: record.notes,
        _branch_id: record.branch_id ?? currentBranch?.id ?? null,
      });
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: () => {
      toast.success("Attendance recorded");
      invalidate();
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const requestCorrection = useMutation({
    mutationFn: async (input: {
      attendance_id?: string | null;
      employee_id: string;
      attendance_date: string;
      proposed_clock_in?: string | null;
      proposed_clock_out?: string | null;
      proposed_status?: string | null;
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc("attendance_request_correction", {
        _attendance_id: input.attendance_id ?? null,
        _employee_id: input.employee_id,
        _date: input.attendance_date,
        _proposed_clock_in: input.proposed_clock_in ?? null,
        _proposed_clock_out: input.proposed_clock_out ?? null,
        _proposed_status: input.proposed_status ?? null,
        _reason: input.reason,
      });
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: (data: any) => {
      toast.success("Correction request submitted");
      invalidate();
      const correctionId = (data && (data.id || data.correction_id)) as string | undefined;
      if (currentOrg?.id && correctionId) {
        void dispatchApprovalNotification({
          organizationId: currentOrg.id,
          entityType: "attendance_correction",
          entityId: correctionId,
          event: "submitted",
          actorUserId: user?.id ?? null,
        });
      }
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const reviewCorrection = useMutation({
    mutationFn: async ({
      id,
      action,
      note,
    }: {
      id: string;
      action: "approved" | "rejected";
      note?: string;
    }) => {
      const fn =
        action === "approved"
          ? "attendance_approve_correction"
          : "attendance_reject_correction";
      const { data, error } = await supabase.rpc(fn, {
        _correction_id: id,
        _review_note: note ?? null,
      });
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: (_, vars) => {
      toast.success(`Correction ${vars.action}`);
      invalidate();
      if (currentOrg?.id) {
        void dispatchApprovalNotification({
          organizationId: currentOrg.id,
          entityType: "attendance_correction",
          entityId: vars.id,
          event: vars.action,
          actorUserId: user?.id ?? null,
        });
      }
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  // SAFETY NET (enterprise parity): any OPEN session must always appear in
  // the dated `records` set when its attendance_date falls in the requested
  // window, even if the dated query missed it (timezone edge, branch filter
  // edge, RLS edge). Without this, the roster synthesizes an "absent" row
  // for an employee who is actively clocked in — the symptom reported in
  // production where "Present = 0" while "Checked in now = 1".
  const mergedRecords: AttendanceRecord[] = (() => {
    const byId = new Map<string, AttendanceRecord>(records.map((r) => [r.id, r]));
    for (const s of openSessions as any[]) {
      if (!s?.id || byId.has(s.id)) continue;
      if (!s.attendance_date || s.attendance_date < from || s.attendance_date > to) continue;
      byId.set(s.id, {
        id: s.id,
        organization_id: currentOrg?.id ?? "",
        business_id: currentBusiness?.id ?? "",
        branch_id: s.branch_id ?? null,
        employee_id: s.employee_id,
        attendance_date: s.attendance_date,
        clock_in: s.clock_in,
        clock_out: null,
        worked_hours: null,
        overtime_hours: null,
        break_duration_minutes: null,
        status: "present",
        notes: null,
        clock_in_method: null,
        clock_in_location: null,
        clock_out_location: null,
        approved_by: null,
        approved_at: null,
        correction_status: "none",
        correction_reason: null,
        corrected_by: null,
        corrected_at: null,
        original_clock_in: null,
        original_clock_out: null,
        is_locked: false,
        locked_by_payroll_run_id: null,
        expected_hours: null,
        late_minutes: null,
        early_leave_minutes: null,
        attendance_date_end: null,
        created_by: null,
        created_at: s.clock_in ?? new Date().toISOString(),
        updated_at: s.clock_in ?? new Date().toISOString(),
        employee: s.employee,
      } as AttendanceRecord);
    }
    return Array.from(byId.values());
  })();

  const todayRecords = mergedRecords.filter((r) => r.attendance_date === today);
  const checkedInNow = openSessions.length;
  const overnightOpenSessions = openSessions.filter(
    (s: any) => s.attendance_date && s.attendance_date < today,
  );
  const pendingCorrections = mergedRecords.filter(
    (r) => r.correction_status === "pending"
  );

  return {
    records: mergedRecords,
    isLoading,
    clockIn: clockIn.mutate,
    clockOut: clockOut.mutate,
    createAttendance: createAttendance.mutate,
    requestCorrection: requestCorrection.mutate,
    reviewCorrection: reviewCorrection.mutate,
    isClockingIn: clockIn.isPending,
    isClockingOut: clockOut.isPending,
    todayRecords,
    checkedInNow,
    openSessions,
    overnightOpenSessions,
    pendingCorrections,
  };
}
