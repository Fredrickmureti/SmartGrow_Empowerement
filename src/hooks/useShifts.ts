/**
 * useShifts / useShiftAssignments / useShiftSwaps — Turn E (Roster).
 *
 * Pure CRUD hooks over the new shift/roster tables. RLS already enforces
 * "org member can read shifts; HR write to mutate". For assignments, RLS
 * lets employees read their own rows so the self-service view is the same
 * hook with an employee_id filter.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { dispatchApprovalNotification } from "@/lib/hr/approvalNotifications";

export interface Shift {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  name: string;
  code: string | null;
  start_time: string;
  end_time: string;
  break_minutes: number;
  paid_break: boolean;
  crosses_midnight: boolean;
  night_differential_pct: number;
  color: string;
  is_active: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShiftAssignment {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  shift_id: string;
  assignment_date: string;
  status: "planned" | "published" | "swapped" | "cancelled" | "completed" | "no_show";
  source: "planned" | "swap" | "on_call" | "overtime" | "adjusted";
  notes: string | null;
  published_at: string | null;
  created_at: string;
  shift?: Shift;
}

export interface ShiftSwapRequest {
  id: string;
  organization_id: string;
  requester_employee_id: string;
  requester_assignment_id: string;
  target_employee_id: string | null;
  target_assignment_id: string | null;
  reason: string | null;
  status:
    | "pending"
    | "target_accepted"
    | "target_declined"
    | "approved"
    | "rejected"
    | "cancelled"
    | "applied";
  approver_user_id: string | null;
  approver_notes: string | null;
  approver_decided_at: string | null;
  applied_at: string | null;
  created_at: string;
}

export function useShifts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ["shifts", currentOrg?.id, currentBusiness?.id ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("shifts")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("start_time", { ascending: true });
      if (currentBusiness?.id) q = q.or(`business_id.eq.${currentBusiness.id},business_id.is.null`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Shift[];
    },
    enabled: !!currentOrg?.id,
  });

  const createShift = useMutation({
    mutationFn: async (
      input: Partial<Shift> & { name: string; start_time: string; end_time: string },
    ) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data, error } = await supabase
        .from("shifts")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id ?? null,
          break_minutes: 0,
          paid_break: false,
          crosses_midnight: input.end_time <= input.start_time,
          night_differential_pct: 0,
          color: "#3b82f6",
          is_active: true,
          ...input,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shifts"] });
      toast.success("Shift created");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateShift = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Shift> }) => {
      const { error } = await supabase.from("shifts").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shifts"] });
      toast.success("Shift updated");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deleteShift = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("shifts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shifts"] });
      toast.success("Shift deleted");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { shifts, isLoading, createShift, updateShift, deleteShift };
}

export function useShiftAssignments(params: {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  employeeId?: string;
}) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: assignments = [], isLoading, refetch } = useQuery({
    queryKey: [
      "shift-assignments",
      currentOrg?.id,
      params.from,
      params.to,
      params.employeeId ?? null,
    ],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("shift_assignments")
        .select("*, shift:shifts(*)")
        .eq("organization_id", currentOrg.id)
        .gte("assignment_date", params.from)
        .lte("assignment_date", params.to)
        .order("assignment_date", { ascending: true });
      if (params.employeeId) q = q.eq("employee_id", params.employeeId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ShiftAssignment[];
    },
    enabled: !!currentOrg?.id,
  });

  const assign = useMutation({
    mutationFn: async (input: {
      employee_id: string;
      shift_id: string;
      assignment_date: string;
      business_id?: string | null;
      branch_id?: string | null;
      notes?: string | null;
    }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data, error } = await supabase
        .from("shift_assignments")
        .insert({
          organization_id: currentOrg.id,
          status: "planned",
          source: "planned",
          ...input,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shift-assignments"] });
      toast.success("Shift assigned");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateStatus = useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: ShiftAssignment["status"];
    }) => {
      const { error } = await supabase
        .from("shift_assignments")
        .update({
          status,
          ...(status === "published" ? { published_at: new Date().toISOString() } : {}),
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shift-assignments"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("shift_assignments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shift-assignments"] });
      toast.success("Assignment removed");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { assignments, isLoading, refetch, assign, updateStatus, remove };
}

export function useShiftSwaps(employeeId?: string) {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: swaps = [], isLoading } = useQuery({
    queryKey: ["shift-swaps", currentOrg?.id, employeeId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("shift_swap_requests")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });
      if (employeeId) {
        q = q.or(
          `requester_employee_id.eq.${employeeId},target_employee_id.eq.${employeeId}`,
        );
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ShiftSwapRequest[];
    },
    enabled: !!currentOrg?.id,
  });

  const create = useMutation({
    mutationFn: async (input: {
      requester_employee_id: string;
      requester_assignment_id: string;
      target_employee_id?: string | null;
      target_assignment_id?: string | null;
      reason?: string | null;
    }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data, error } = await supabase
        .from("shift_swap_requests")
        .insert({ organization_id: currentOrg.id, status: "pending", ...input })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["shift-swaps"] });
      toast.success("Swap request submitted");
      if (currentOrg?.id && data?.id) {
        void dispatchApprovalNotification({
          organizationId: currentOrg.id,
          entityType: "shift_swap_request",
          entityId: data.id,
          event: "submitted",
        });
      }
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const respond = useMutation({
    mutationFn: async ({
      id,
      accept,
    }: {
      id: string;
      accept: boolean;
    }) => {
      const { error } = await supabase
        .from("shift_swap_requests")
        .update({
          status: accept ? "target_accepted" : "target_declined",
          target_responded_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shift-swaps"] }),
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const decide = useMutation({
    mutationFn: async ({
      id,
      approve,
      notes,
    }: {
      id: string;
      approve: boolean;
      notes?: string;
    }) => {
      const user = (await supabase.auth.getUser()).data.user;
      const { error } = await supabase
        .from("shift_swap_requests")
        .update({
          status: approve ? "approved" : "rejected",
          approver_user_id: user?.id ?? null,
          approver_decided_at: new Date().toISOString(),
          approver_notes: notes ?? null,
        })
        .eq("id", id);
      if (error) throw error;
      return { user_id: user?.id ?? null };
    },
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: ["shift-swaps"] });
      toast.success("Decision recorded");
      if (currentOrg?.id) {
        void dispatchApprovalNotification({
          organizationId: currentOrg.id,
          entityType: "shift_swap_request",
          entityId: vars.id,
          event: vars.approve ? "approved" : "rejected",
          actorUserId: res?.user_id ?? null,
        });
      }
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { swaps, isLoading, create, respond, decide };
}
