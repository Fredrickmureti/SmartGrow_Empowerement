import { normalizeError } from "@/services/resilience";
/**
 * Table Sessions Hook
 * 
 * Manages table occupancy, guest counts, and session lifecycle.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { toast } from "sonner";

export interface TableSession {
  id: string;
  organization_id: string;
  business_id: string | null;
  table_id: string;
  shift_id: string | null;
  status: "open" | "ordered" | "served" | "paid" | "closed";
  guests_count: number | null;
  server_id: string | null;
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
  created_at: string;
  // Joined data
  table?: {
    id: string;
    table_number: string;
    floor_id: string;
  };
}

export interface OpenTableInput {
  table_id: string;
  shift_id?: string | null;
  guests_count?: number;
  notes?: string;
  server_id?: string | null;
}

export interface UpdateSessionInput {
  session_id: string;
  status?: "open" | "ordered" | "served" | "paid" | "closed";
  guests_count?: number;
  notes?: string;
}

export function useTableSessions(shiftId?: string | null) {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  // Stage R7 — restaurant tables are branch-scoped. Without this filter a
  // Branch A operator can see Branch B's open tables and guest counts.
  const { currentBranch } = useBranch();
  const { canOversee } = usePOSOverseer();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  // Fetch all active sessions for the current shift
  const sessionsQuery = useQuery({
    queryKey: ["pos-table-sessions", orgId, bizId, branchId, shiftId, canOversee],
    queryFn: async () => {
      if (!orgId || !bizId) return [];
      // No-branch context: only overseers may read company-wide; others get nothing.
      if (!branchId && !canOversee) return [];

      let query = supabase
        .from("pos_table_sessions")
        .select(`
          *,
          table:pos_tables(id, table_number, floor_id)
        `)
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .is("closed_at", null);

      if (branchId) {
        query = query.eq("branch_id", branchId);
      }
      if (shiftId) {
        query = query.eq("shift_id", shiftId);
      }

      const { data, error } = await query.order("opened_at", { ascending: false });

      if (error) throw error;
      return data as TableSession[];
    },
    enabled: !!orgId && !!bizId,
  });

  // Get session for a specific table
  const useTableSession = (tableId: string | null) => {
    return useQuery({
      queryKey: ["pos-table-session", tableId, orgId, bizId, branchId],
      queryFn: async () => {
        if (!tableId || !orgId || !bizId) return null;
        if (!branchId && !canOversee) return null;

        let q = supabase
          .from("pos_table_sessions")
          .select("*")
          .eq("organization_id", orgId)
          .eq("business_id", bizId)
          .eq("table_id", tableId)
          .is("closed_at", null);
        if (branchId) q = q.eq("branch_id", branchId);

        const { data, error } = await q.maybeSingle();

        if (error) throw error;
        return data as TableSession | null;
      },
      enabled: !!tableId && !!orgId && !!bizId,
    });
  };

  // Open a table (start new session)
  const openTable = useMutation({
    mutationFn: async (input: OpenTableInput) => {
      if (!orgId) throw new Error("No organization selected");
      if (!bizId) throw new Error("No company selected");
      
      // First check if table already has an active session
      const { data: existingSession } = await supabase
        .from("pos_table_sessions")
        .select("id")
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .eq("table_id", input.table_id)
        .is("closed_at", null)
        .maybeSingle();
      
      if (existingSession) {
        throw new Error("Table already has an active session");
      }
      
      const { data, error } = await supabase
        .from("pos_table_sessions")
        .insert({
          organization_id: orgId,
          business_id: bizId,
          table_id: input.table_id,
          shift_id: input.shift_id || null,
          status: "ordered",
          guests_count: input.guests_count || null,
          notes: input.notes || null,
          server_id: input.server_id || null,
          opened_at: new Date().toISOString(),
        } as any)
        .select()
        .single();
      
      if (error) throw error;
      return data as TableSession;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-table-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["pos-tables"] });
      toast.success("Table opened successfully");
    },
    onError: (error) => {
      toast.error(normalizeError(error).message);
    },
  });

  // Update session status
  const updateSession = useMutation({
    mutationFn: async (input: UpdateSessionInput) => {
      const { session_id, ...updates } = input;
      
      const { data, error } = await supabase
        .from("pos_table_sessions")
        .update(updates)
        .eq("id", session_id)
        .select()
        .single();
      
      if (error) throw error;
      return data as TableSession;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-table-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["pos-tables"] });
    },
    onError: (error) => {
      toast.error("Failed to update session: " + normalizeError(error).message);
    },
  });

  // Close table (end session)
  const closeTable = useMutation({
    mutationFn: async (sessionId: string) => {
      const { data, error } = await supabase
        .from("pos_table_sessions")
        .update({
          status: "closed",
          closed_at: new Date().toISOString(),
        })
        .eq("id", sessionId)
        .select()
        .single();
      
      if (error) throw error;
      return data as TableSession;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-table-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["pos-tables"] });
      toast.success("Table closed successfully");
    },
    onError: (error) => {
      toast.error("Failed to close table: " + normalizeError(error).message);
    },
  });

  // @deprecated Use useTableTransfer.moveSession instead — it is atomic and safer.
  // Kept as no-op to avoid breaking any potential callers.
  const transferTable = {
    mutateAsync: async (_args: { fromSessionId: string; toTableId: string }) => {
      console.warn("useTableSessions.transferTable is deprecated. Use useTableTransfer.moveSession instead.");
      throw new Error("transferTable is deprecated. Use useTableTransfer.moveSession instead.");
    },
    isPending: false,
  };

  // Get table status summary for floor view
  const getTableStatusSummary = () => {
    const sessions = sessionsQuery.data || [];
    return {
      occupied: sessions.filter(s => s.status === "ordered" || s.status === "served").length,
      reserved: 0, // 'reserved' state was retired; reservations now live in pos_table_bookings
      pending_payment: sessions.filter(s => s.status === "served").length,
      available: 0, // Calculated from total tables - active sessions
    };
  };

  return {
    sessions: sessionsQuery.data || [],
    isLoading: sessionsQuery.isLoading,
    useTableSession,
    openTable,
    updateSession,
    closeTable,
    transferTable,
    getTableStatusSummary,
  };
}
