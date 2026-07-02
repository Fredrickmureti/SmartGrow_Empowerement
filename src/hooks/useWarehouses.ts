import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranches } from "./useBranches";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export interface Warehouse {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  manager_name: string | null;
  manager_email: string | null;
  manager_phone: string | null;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface WarehouseStock {
  id: string;
  organization_id: string;
  warehouse_id: string;
  product_id: string;
  quantity: number;
  reserved_quantity: number;
  reorder_level: number | null;
  reorder_quantity: number | null;
  bin_location: string | null;
  last_counted_at: string | null;
  created_at: string;
  updated_at: string;
  product?: {
    name: string;
    sku: string;
  } | null;
  warehouse?: Partial<Warehouse> | null;
}

export interface StockTransfer {
  id: string;
  organization_id: string;
  transfer_number: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  status: string;
  transfer_date: string;
  expected_arrival_date: string | null;
  actual_arrival_date: string | null;
  notes: string | null;
  requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  completed_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  from_warehouse?: Partial<Warehouse> | null;
  to_warehouse?: Partial<Warehouse> | null;
  items?: StockTransferItem[];
}

export interface StockTransferItem {
  id: string;
  transfer_id: string;
  product_id: string;
  quantity_requested: number;
  quantity_sent: number | null;
  quantity_received: number | null;
  notes: string | null;
  product?: {
    name: string;
    sku: string;
  };
}

/**
 * useWarehouses
 *
 * Branch-aware warehouse access. Per ARCHITECTURE.md, warehouses belong to a
 * (business, branch). This hook:
 *   - requires both currentOrg AND currentBusiness before issuing any query
 *     (prevents `business_id = undefined` reaching PostgREST)
 *   - filters listings by currentBranch.id when a branch is active, so users
 *     working inside a branch only see that branch's warehouses
 *   - defaults newly created warehouses to currentBranch.id so the operational
 *     boundary is enforced from the very first row
 */
export function useWarehouses() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id;

  // ===== Warehouses query =====
  // Phase F: in-transit pseudo-warehouses are bookkeeping buckets that hold
  // stock dispatched-but-not-received. They must never appear in operational
  // pickers (transfer source/destination, adjustments, receipts), so we
  // exclude is_in_transit=true here. The dedicated valuation/transit reports
  // can read them directly.
  const { data: warehouses = [], isLoading } = useQuery({
    queryKey: ["warehouses", orgId, businessId, branchId],
    queryFn: async () => {
      if (!orgId || !businessId) return [];
      let query = supabase
        .from("warehouses")
        .select("*")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .or("is_in_transit.is.null,is_in_transit.eq.false");
      if (branchId) query = query.eq("branch_id", branchId);
      const { data, error } = await query.order("name", { ascending: true });
      if (error) throw error;
      return (data || []) as Warehouse[];
    },
    enabled: !!orgId && !!businessId,
  });

  // ===== Transfers query =====
  const { data: transfers = [] } = useQuery({
    queryKey: ["stock-transfers", orgId, businessId, branchId],
    queryFn: async () => {
      if (!orgId || !businessId) return [];
      let query = supabase
        .from("stock_transfers")
        .select(`
          *,
          from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(name, code),
          to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(name, code),
          items:stock_transfer_items(
            *,
            product:products(name, sku)
          )
        `)
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });
      // Defensively narrow to transfers that touch the active branch on either side.
      if (branchId) {
        query = query.or(`from_branch_id.eq.${branchId},to_branch_id.eq.${branchId}`);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as unknown as StockTransfer[];
    },
    enabled: !!orgId && !!businessId,
  });

  // ===== Warehouse stock (on-demand, not auto-fetched) =====
  const fetchWarehouseStock = useCallback(async (warehouseId?: string) => {
    if (!orgId || !businessId) return [];
    let query = supabase
      .from("warehouse_stock")
      .select(`*, product:products(name, sku), warehouse:warehouses(name, code)`)
      .eq("organization_id", orgId)
      .eq("business_id", businessId);
    if (warehouseId) query = query.eq("warehouse_id", warehouseId);
    if (branchId) query = query.eq("branch_id", branchId);
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []) as unknown as WarehouseStock[];
  }, [orgId, businessId, branchId]);

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["warehouses"] });
    queryClient.invalidateQueries({ queryKey: ["stock-transfers"] });
  }, [queryClient]);

  // ===== Mutations =====
  const getNextTransferNumber = async (): Promise<string> => {
    if (!orgId) return "TRF-0001";
    const { data, error } = await supabase.rpc("get_next_transfer_number", { _org_id: orgId });
    if (error) return `TRF-${Date.now()}`;
    return data || "TRF-0001";
  };

  const createWarehouse = async (
    warehouse: Omit<Warehouse, "id" | "organization_id" | "business_id" | "branch_id" | "created_at" | "updated_at"> & { branch_id?: string | null }
  ) => {
    if (!orgId) throw new Error("No organization selected");
    if (!businessId) throw new Error("Select a company before creating a warehouse");
    // Default the branch to the active branch; explicit branch_id (e.g. HQ override) wins.
    const targetBranchId = warehouse.branch_id ?? branchId ?? null;
    if (!targetBranchId) {
      throw new Error("A branch must be active to create a warehouse");
    }
    if (warehouse.is_default) {
      // Clear other defaults within the SAME (business, branch) only.
      await supabase
        .from("warehouses")
        .update({ is_default: false })
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .eq("branch_id", targetBranchId);
    }
    const { branch_id: _drop, ...rest } = warehouse;
    const { data, error } = await supabase
      .from("warehouses")
      .insert({ ...rest, organization_id: orgId, business_id: businessId, branch_id: targetBranchId })
      .select()
      .single();
    if (error) throw error;
    toast.success("Warehouse created successfully");
    invalidateAll();
    return data;
  };

  const updateWarehouse = async (id: string, updates: Partial<Warehouse>) => {
    if (!orgId) throw new Error("No organization selected");
    if (!businessId) throw new Error("Select a company before editing a warehouse");
    if (updates.is_default) {
      // Clear other defaults in the same scope (business + branch of the row being updated).
      const { data: target } = await supabase
        .from("warehouses")
        .select("branch_id")
        .eq("id", id)
        .single();
      const scopeBranchId = updates.branch_id ?? target?.branch_id ?? branchId ?? null;
      let clear = supabase
        .from("warehouses")
        .update({ is_default: false })
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .neq("id", id);
      if (scopeBranchId) clear = clear.eq("branch_id", scopeBranchId);
      await clear;
    }
    const { error } = await supabase.from("warehouses").update(updates).eq("id", id);
    if (error) throw error;
    toast.success("Warehouse updated successfully");
    invalidateAll();
  };

  const deleteWarehouse = async (id: string) => {
    if (!orgId || !businessId) throw new Error("Select a company first");
    // Catch BOTH positive and negative drift — `> 0` would silently allow
    // deletion of a warehouse with negative on-hand from a bad adjustment.
    const { data: stock } = await supabase
      .from("warehouse_stock")
      .select("id")
      .eq("warehouse_id", id)
      .eq("organization_id", orgId)
      .eq("business_id", businessId)
      .neq("quantity", 0)
      .limit(1);
    if (stock && stock.length > 0) throw new Error("Cannot delete warehouse with active stock. Transfer stock out first.");
    const { error } = await supabase
      .from("warehouses")
      .delete()
      .eq("id", id)
      .eq("organization_id", orgId)
      .eq("business_id", businessId);
    if (error) throw error;
    toast.success("Warehouse deleted successfully");
    invalidateAll();
  };

  const createStockTransfer = async (
    fromWarehouseId: string,
    toWarehouseId: string,
    items: { product_id: string; quantity_requested: number }[],
    notes?: string
  ) => {
    if (!orgId || !user) throw new Error("No organization selected");
    if (!businessId) throw new Error("Select a company before creating a transfer");
    const transferNumber = await getNextTransferNumber();
    // Pull org + business in addition to branch so we can defensively reject
    // any attempt to transfer across tenants — RLS is the floor, not the only
    // line of defense.
    const { data: whs, error: whErr } = await supabase
      .from("warehouses")
      .select("id, branch_id, business_id, organization_id")
      .in("id", [fromWarehouseId, toWarehouseId]);
    if (whErr) throw whErr;
    const from = whs?.find(w => w.id === fromWarehouseId);
    const to = whs?.find(w => w.id === toWarehouseId);
    if (!from || !to) throw new Error("Source/destination warehouse not found");
    if (from.organization_id !== orgId || to.organization_id !== orgId) {
      throw new Error("Cross-tenant transfer rejected");
    }
    if (from.business_id !== businessId || to.business_id !== businessId) {
      throw new Error("Both warehouses must belong to the active company");
    }
    const fromBranchId = from.branch_id;
    const toBranchId = to.branch_id;
    if (!fromBranchId || !toBranchId) throw new Error("Source/destination warehouse must be assigned to a branch");
    const transferRow = {
      organization_id: orgId,
      business_id: businessId,
      transfer_number: transferNumber,
      from_warehouse_id: fromWarehouseId,
      to_warehouse_id: toWarehouseId,
      from_branch_id: fromBranchId,
      to_branch_id: toBranchId,
      transfer_date: new Date().toISOString().split("T")[0],
      status: "draft",
      notes: notes ?? null,
      requested_by: user.id,
    };
    const { data: transfer, error: transferError } = await supabase
      .from("stock_transfers")
      .insert(transferRow)
      .select()
      .single();
    if (transferError) throw transferError;
    const transferItems = items.map((item) => ({
      transfer_id: transfer.id, product_id: item.product_id, quantity_requested: item.quantity_requested,
    }));
    const { error: itemsError } = await supabase.from("stock_transfer_items").insert(transferItems);
    if (itemsError) throw itemsError;
    toast.success(`Transfer ${transferNumber} created successfully`);
    invalidateAll();
    return transfer;
  };

  const approveTransfer = async (transferId: string) => {
    if (!user) throw new Error("Not authenticated");
    // Phase F: approval is the *dispatch* leg. The atomic RPC moves stock
    // from source warehouse → in-transit pseudo-warehouse so totals stay
    // truthful while goods are between branches.
    const { data, error } = await supabase.rpc("approve_stock_transfer_atomic" as any, {
      p_transfer_id: transferId,
      p_user_id: user.id,
    });
    if (error) throw error;
    const result = data as any;
    if (!result?.success) throw new Error(result?.error || "Transfer approval failed");
    toast.success("Transfer approved & dispatched");
    invalidateAll();
  };

  const completeTransfer = async (transferId: string, items: { id: string; quantity_received: number }[]) => {
    if (!user || !orgId) throw new Error("Not authenticated");
    const { data, error } = await supabase.rpc("complete_stock_transfer_atomic" as any, {
      p_transfer_id: transferId,
      p_items: items.map(i => ({ id: i.id, quantity_received: i.quantity_received })),
      p_user_id: user.id,
    });
    if (error) throw error;
    const result = data as any;
    if (!result?.success) throw new Error(result?.error || "Transfer completion failed");
    toast.success("Transfer completed");
    invalidateAll();
  };

  const cancelTransfer = async (transferId: string) => {
    if (!user) throw new Error("Not authenticated");
    // Phase F: if the transfer was already approved (dispatched to in-transit),
    // cancellation must reverse the dispatch leg so stock returns to source.
    // The RPC handles both cases atomically.
    const { data, error } = await supabase.rpc("cancel_stock_transfer_atomic" as any, {
      p_transfer_id: transferId,
      p_user_id: user.id,
    });
    if (error) throw error;
    const result = data as any;
    if (!result?.success) throw new Error(result?.error || "Transfer cancellation failed");
    toast.success("Transfer cancelled");
    invalidateAll();
  };

  return {
    warehouses,
    activeWarehouses: warehouses.filter((w) => w.is_active),
    warehouseStock: [] as WarehouseStock[], // kept for backward compat; use fetchWarehouseStock
    transfers,
    isLoading,
    getNextTransferNumber,
    createWarehouse,
    updateWarehouse,
    deleteWarehouse,
    createStockTransfer,
    approveTransfer,
    completeTransfer,
    cancelTransfer,
    fetchWarehouseStock,
    refreshWarehouses: invalidateAll,
    refreshTransfers: invalidateAll,
  };
}
