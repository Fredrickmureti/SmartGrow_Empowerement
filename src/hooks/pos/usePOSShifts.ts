import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface POSShift {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string;
  register_id: string;
  user_id: string;
  shift_number: string;
  opened_at: string;
  closed_at: string | null;
  opening_cash: number;
  expected_cash: number;
  actual_cash: number | null;
  cash_difference: number | null;
  status: "open" | "closed" | "reconciled";
  notes: string | null;
  closed_by: string | null;
  gl_posted_at: string | null;
  created_at: string;
  updated_at: string;
  register?: {
    id: string;
    register_name: string;
    register_code: string;
  };
}

export interface OpenShiftData {
  register_id: string;
  opening_cash: number;
  notes?: string;
}

export interface CloseShiftData {
  shift_id: string;
  actual_cash: number;
  notes?: string;
  blind_close?: boolean;
  manager_override_id?: string | null;
  denomination_counted?: boolean;
}

export function usePOSShifts(registerId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // Stage B branch isolation: dashboards (rescue alert, unsynced badge,
  // current-shift card) must only show shifts for the active branch.
  const { currentBranch } = useBranch();
  const { canOversee } = usePOSOverseer();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Get recent shifts (last 30 days, max 50) to prevent unbounded loading at scale
  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ["pos-shifts", currentOrg?.id, currentBusiness?.id, currentBranch?.id ?? null, registerId, canOversee],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      // Stage B4: no-branch state only yields rows for overseers.
      if (!currentBranch?.id && !canOversee) return [];

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      let query = supabase
        .from("pos_shifts")
        .select(`
          *,
          register:pos_registers(id, register_name, register_code)
        `)
        .eq("organization_id", currentOrg.id)
        .gte("opened_at", thirtyDaysAgo.toISOString());

      query = query.eq("business_id", currentBusiness.id);
      if (currentBranch?.id) {
        query = query.eq("branch_id", currentBranch.id);
      }
      const { data, error } = await query
        .order("opened_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return data as POSShift[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // Get current open shift for a register.
  // Stage R7 — keyed by branch as well so a context switch invalidates
  // and prevents foreign-branch shift state from being surfaced.
  const { data: currentShift, isLoading: isLoadingCurrentShift } = useQuery({
    queryKey: ["pos-current-shift", registerId, currentBranch?.id ?? null],
    queryFn: async () => {
      if (!registerId) return null;

      let q = supabase
        .from("pos_shifts")
        .select(`
          *,
          register:pos_registers(id, register_name, register_code)
        `)
        .eq("register_id", registerId)
        .eq("status", "open");
      if (currentBranch?.id) q = q.eq("branch_id", currentBranch.id);

      const { data, error } = await q.maybeSingle();

      if (error) throw error;
      return data as POSShift | null;
    },
    enabled: !!registerId,
  });

  // Get user's current open shift in the ACTIVE BRANCH only.
  // Stage R7 — previously this query ignored branch context, so a shift
  // opened in HQ remained "current" after switching into Branch A and
  // triggered RescueSessionAlert / Resume-CTA cross-branch leakage.
  const { data: userCurrentShift } = useQuery({
    queryKey: [
      "pos-user-current-shift",
      user?.id,
      currentBusiness?.id,
      currentBranch?.id ?? null,
      canOversee,
    ],
    queryFn: async () => {
      if (!user?.id || !currentOrg?.id || !currentBusiness?.id) return null;
      // In no-branch context, only overseers may see their cross-branch
      // current shift (read-only). Operators get null so they can't
      // accidentally resume a foreign-branch session.
      if (!currentBranch?.id && !canOversee) return null;

      let q = supabase
        .from("pos_shifts")
        .select(`
          *,
          register:pos_registers(id, register_name, register_code)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("user_id", user.id)
        .eq("status", "open");
      if (currentBranch?.id) q = q.eq("branch_id", currentBranch.id);

      const { data, error } = await q
        .order("opened_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return data as POSShift | null;
    },
    enabled: !!user?.id && !!currentOrg?.id && !!currentBusiness?.id,
  });

  const openShift = useMutation({
    mutationFn: async (data: OpenShiftData) => {
      if (!currentOrg?.id || !user?.id) throw new Error("Not authenticated");
      if (!currentBusiness?.id) throw new Error("No company selected");

      // Single transactional path. The RPC validates the register, detects
      // an existing open shift across branches (returning a structured
      // `open_shift_exists` exception with branch name), generates the
      // shift number, inserts the row, and stamps the register — all
      // atomically. This eliminates the TOCTOU window between the old
      // JS pre-check and the partial-unique-index insert.
      const { data: result, error } = await supabase.rpc(
        "open_pos_shift_safe" as any,
        {
          p_register_id: data.register_id,
          p_opening_cash: data.opening_cash,
          p_notes: data.notes ?? null,
        } as any,
      );

      if (error) {
        const code = (error as any).code as string | undefined;
        const detailsRaw = (error as any).details as string | undefined;
        let parsed: any = null;
        if (detailsRaw) {
          try { parsed = JSON.parse(detailsRaw); } catch { /* plain text */ }
        }
        const msg = (error as any).message || "";

        if (msg === "open_shift_exists" && parsed) {
          const branchLabel = parsed.branch_name ? ` in branch "${parsed.branch_name}"` : "";
          throw new Error(
            `You already have an open shift (${parsed.shift_number})${branchLabel}. Please close it first.`,
          );
        }
        if (msg === "register_shift_in_progress") {
          throw new Error("This register already has an open shift. Ask the previous cashier to close it.");
        }
        if (msg === "register_missing_branch") {
          throw new Error("Register is missing branch context. Reconfigure the register before opening a shift.");
        }
        if (msg === "register_not_found") {
          throw new Error("Register not found in the current company.");
        }
        if (code === "23505") {
          throw new Error("A shift is already open on this register. Please close it first.");
        }
        throw error;
      }

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["pos-current-shift"] });
      queryClient.invalidateQueries({ queryKey: ["pos-user-current-shift"] });
      queryClient.invalidateQueries({ queryKey: ["pos-registers"] });
      toast.success("Shift opened successfully");
    },
    onError: (error: Error) => {
      toast.error(`Failed to open shift: ${normalizeError(error).message}`);
    },
  });

  const closeShift = useMutation({
    mutationFn: async (data: CloseShiftData) => {
      if (!user?.id) throw new Error("Not authenticated");

      // Stage 7: shift close goes through the canonical RPC. It runs the gate
      // (held orders, in-flight txns, permission), reads expected cash from
      // v_pos_cash_expected, enforces variance threshold + manager override
      // (single-use), then closes the shift. The existing close trigger posts
      // the aggregated GL entry.
      const { data: result, error } = await supabase.rpc(
        "close_pos_shift" as any,
        {
          p_shift_id: data.shift_id,
          p_actual_cash: data.actual_cash,
          p_notes: data.notes ?? null,
          p_blind_close: data.blind_close ?? false,
          p_manager_override_id: data.manager_override_id ?? null,
          p_denomination_counted: data.denomination_counted ?? false,
        } as any
      );

      if (error) throw error;
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["pos-current-shift"] });
      queryClient.invalidateQueries({ queryKey: ["pos-user-current-shift"] });
      toast.success("Shift closed successfully");
    },
    onError: (error: Error) => {
      // Override-required is a UX state, not a failure: the dialog detects it
      // and prompts for a manager PIN. Stay silent here to avoid a misleading
      // red "Failed to close shift" toast on top of the inline PIN prompt.
      const anyErr = error as unknown as { code?: string; message?: string };
      const isOverrideRequired =
        anyErr?.code === "42501" ||
        (typeof anyErr?.message === "string" &&
          /override_required|exceeds tolerance/i.test(anyErr.message));
      if (isOverrideRequired) return;
      toast.error(`Failed to close shift: ${normalizeError(error).message}`);
    },
  });

  const openShifts = shifts.filter((s) => s.status === "open");
  const todayShifts = shifts.filter(
    (s) => new Date(s.opened_at).toDateString() === new Date().toDateString()
  );

  return {
    shifts,
    currentShift,
    userCurrentShift,
    openShifts,
    todayShifts,
    isLoading,
    isLoadingCurrentShift,
    openShift,
    closeShift,
  };
}
