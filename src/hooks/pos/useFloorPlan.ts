import { normalizeError } from "@/services/resilience";
/**
 * Floor Plan Management Hook
 * 
 * Handles CRUD operations for POS floors and tables in restaurant mode.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { toast } from "sonner";

export interface POSFloor {
  id: string;
  organization_id: string;
  register_id: string | null;
  name: string;
  background_color: string;
  background_image_url: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface POSTable {
  id: string;
  organization_id: string;
  floor_id: string;
  table_number: string;
  seats: number;
  shape: "square" | "round" | "rectangle";
  width: number;
  height: number;
  position_x: number;
  position_y: number;
  color: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // Joined data
  current_session?: POSTableSession | null;
}

export interface POSTableSession {
  id: string;
  organization_id: string;
  table_id: string;
  shift_id: string | null;
  status: "open" | "ordered" | "served" | "paid" | "closed";
  guests_count: number | null;
  server_id: string | null;
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
}

export interface CreateFloorInput {
  name: string;
  register_id?: string | null;
  background_color?: string;
  sort_order?: number;
}

export interface UpdateFloorInput {
  id: string;
  name?: string;
  register_id?: string | null;
  background_color?: string;
  background_image_url?: string | null;
  sort_order?: number;
  is_active?: boolean;
}

export interface CreateTableInput {
  floor_id: string;
  table_number: string;
  seats?: number;
  shape?: "square" | "round" | "rectangle";
  width?: number;
  height?: number;
  position_x?: number;
  position_y?: number;
  color?: string;
}

export interface UpdateTableInput {
  id: string;
  table_number?: string;
  seats?: number;
  shape?: "square" | "round" | "rectangle";
  width?: number;
  height?: number;
  position_x?: number;
  position_y?: number;
  color?: string;
  is_active?: boolean;
}

export function useFloorPlan() {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  // Stage R3 — branch isolation. Floors and tables are now branch-scoped;
  // HQ/no-branch context shows nothing to non-overseers (mirrors registers).
  const { currentBranch } = useBranch();
  const { canOversee } = usePOSOverseer();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const branchId = currentBranch?.id ?? null;

  // Fetch all floors
  const floorsQuery = useQuery({
    queryKey: ["pos-floors", orgId, currentBusiness?.id, branchId, canOversee],
    queryFn: async () => {
      if (!orgId || !currentBusiness?.id) return [];
      if (!branchId && !canOversee) return [];

      let query = supabase
        .from("pos_floors")
        .select("*")
        .eq("organization_id", orgId)
        .eq("business_id", currentBusiness.id);

      if (branchId) query = query.eq("branch_id", branchId);

      const { data, error } = await query.order("sort_order", { ascending: true });

      if (error) throw error;
      return data as POSFloor[];
    },
    enabled: !!orgId && !!currentBusiness?.id,
  });

  // Fetch tables for a specific floor with current session status
  const useFloorTables = (floorId: string | null) => {
    return useQuery({
      queryKey: ["pos-tables", floorId, orgId, currentBusiness?.id, branchId, canOversee],
      queryFn: async () => {
        if (!floorId || !orgId || !currentBusiness?.id) return [];
        if (!branchId && !canOversee) return [];

        // Fetch tables first
        let tableQuery = supabase
          .from("pos_tables")
          .select("*")
          .eq("organization_id", orgId)
          .eq("business_id", currentBusiness.id)
          .eq("floor_id", floorId)
          .eq("is_active", true);
        if (branchId) tableQuery = tableQuery.eq("branch_id", branchId);
        const { data: tables, error: tablesError } = await tableQuery;

        if (tablesError) throw tablesError;
        if (!tables || tables.length === 0) return [];

        // Fetch active sessions for these tables (also branch-scoped)
        const tableIds = tables.map(t => t.id);
        let sessionQuery = supabase
          .from("pos_table_sessions")
          .select("*")
          .eq("organization_id", orgId)
          .eq("business_id", currentBusiness.id)
          .in("table_id", tableIds)
          .is("closed_at", null);
        if (branchId) sessionQuery = sessionQuery.eq("branch_id", branchId);
        const { data: sessions } = await sessionQuery;

        // Map sessions to tables
        const sessionsMap = new Map(
          (sessions || []).map(s => [s.table_id, s])
        );

        return tables.map(table => ({
          ...table,
          shape: table.shape as "square" | "round" | "rectangle",
          current_session: sessionsMap.get(table.id) as POSTableSession | undefined,
        })) as POSTable[];
      },
      enabled: !!floorId && !!orgId && !!currentBusiness?.id,
    });
  };

  // Create floor
  const createFloor = useMutation({
    mutationFn: async (input: CreateFloorInput) => {
      if (!orgId) throw new Error("No organization selected");
      const businessId = currentBusiness?.id;
      if (!businessId) throw new Error("No company selected");
      if (!branchId) throw new Error("Switch to a branch before creating a floor");

      const { data, error } = await supabase
        .from("pos_floors")
        .insert({
          organization_id: orgId,
          business_id: businessId,
          branch_id: branchId,
          name: input.name,
          register_id: input.register_id || null,
          background_color: input.background_color || "#f3f4f6",
          sort_order: input.sort_order || 0,
        })
        .select()
        .single();

      if (error) throw error;
      return data as POSFloor;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-floors", orgId] });
      toast.success("Floor created successfully");
    },
    onError: (error) => {
      toast.error("Failed to create floor: " + normalizeError(error).message);
    },
  });

  // Update floor
  const updateFloor = useMutation({
    mutationFn: async (input: UpdateFloorInput) => {
      const { id, ...updates } = input;
      
      const { data, error } = await supabase
        .from("pos_floors")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();
      
      if (error) throw error;
      return data as POSFloor;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-floors", orgId] });
      toast.success("Floor updated successfully");
    },
    onError: (error) => {
      toast.error("Failed to update floor: " + normalizeError(error).message);
    },
  });

  // Delete floor
  const deleteFloor = useMutation({
    mutationFn: async (floorId: string) => {
      const { error } = await supabase
        .from("pos_floors")
        .delete()
        .eq("id", floorId);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-floors", orgId] });
      toast.success("Floor deleted successfully");
    },
    onError: (error) => {
      toast.error("Failed to delete floor: " + normalizeError(error).message);
    },
  });

  // Create table
  const createTable = useMutation({
    mutationFn: async (input: CreateTableInput) => {
      if (!orgId) throw new Error("No organization selected");
      const businessId = currentBusiness?.id;
      if (!businessId) throw new Error("No company selected");
      if (!branchId) throw new Error("Switch to a branch before creating a table");

      const { data, error } = await supabase
        .from("pos_tables")
        .insert({
          organization_id: orgId,
          business_id: businessId,
          branch_id: branchId,
          floor_id: input.floor_id,
          table_number: input.table_number,
          seats: input.seats || 4,
          shape: input.shape || "square",
          width: input.width || 100,
          height: input.height || 100,
          position_x: input.position_x || 0,
          position_y: input.position_y || 0,
          color: input.color || "#ffffff",
        })
        .select()
        .single();

      if (error) throw error;
      return data as POSTable;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["pos-tables", variables.floor_id] });
      toast.success("Table created successfully");
    },
    onError: (error) => {
      toast.error("Failed to create table: " + normalizeError(error).message);
    },
  });

  // Update table
  const updateTable = useMutation({
    mutationFn: async (input: UpdateTableInput) => {
      const { id, ...updates } = input;
      
      const { data, error } = await supabase
        .from("pos_tables")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();
      
      if (error) throw error;
      return data as POSTable;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["pos-tables", data.floor_id] });
      toast.success("Table updated successfully");
    },
    onError: (error) => {
      toast.error("Failed to update table: " + normalizeError(error).message);
    },
  });

  // Update table positions (batch update for drag-and-drop)
  const updateTablePositions = useMutation({
    mutationFn: async (tables: { id: string; position_x: number; position_y: number }[]) => {
      const promises = tables.map(table => 
        supabase
          .from("pos_tables")
          .update({ 
            position_x: table.position_x, 
            position_y: table.position_y,
            updated_at: new Date().toISOString()
          })
          .eq("id", table.id)
      );
      
      await Promise.all(promises);
    },
    onSuccess: () => {
      // Invalidate all table queries
      queryClient.invalidateQueries({ queryKey: ["pos-tables"] });
    },
    onError: (error) => {
      toast.error("Failed to update table positions: " + normalizeError(error).message);
    },
  });

  // Delete table
  const deleteTable = useMutation({
    mutationFn: async ({ tableId, floorId }: { tableId: string; floorId: string }) => {
      const { error } = await supabase
        .from("pos_tables")
        .delete()
        .eq("id", tableId);
      
      if (error) throw error;
      return { floorId };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["pos-tables", data.floorId] });
      toast.success("Table deleted successfully");
    },
    onError: (error) => {
      toast.error("Failed to delete table: " + normalizeError(error).message);
    },
  });

  return {
    floors: floorsQuery.data || [],
    isLoadingFloors: floorsQuery.isLoading,
    useFloorTables,
    createFloor,
    updateFloor,
    deleteFloor,
    createTable,
    updateTable,
    updateTablePositions,
    deleteTable,
  };
}
