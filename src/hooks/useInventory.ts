import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranches } from "./useBranches";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface StockMovement {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  product_id: string;
  movement_type: 'purchase' | 'sale' | 'pos_sale' | 'pos_return' | 'adjustment' | 'return_in' | 'return_out' | 'transfer' | 'opening' | 'receipt' | 'delivery' | 'scrap' | 'count';
  quantity: number;
  unit_cost: number | null;
  reference_type: string | null;
  reference_id: string | null;
  warehouse_id: string | null;
  notes: string | null;
  movement_date: string;
  created_by: string | null;
  created_at: string;
  products?: {
    id: string;
    name: string;
    sku: string | null;
  };
  warehouses?: {
    id: string;
    name: string;
  } | null;
}

export interface StockAdjustment {
  id: string;
  organization_id: string;
  adjustment_number: string;
  adjustment_date: string;
  reason: string;
  notes: string | null;
  status: 'draft' | 'pending_approval' | 'approved' | 'cancelled' | 'reversed';
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Wave 2 — reversal links. Set by reverse_stock_adjustment_atomic.
  reverses_adjustment_id?: string | null;
  reversed_by_adjustment_id?: string | null;
  reversal_reason?: string | null;
  items?: StockAdjustmentItem[];
}

export interface StockAdjustmentItem {
  id: string;
  adjustment_id: string;
  product_id: string;
  quantity_before: number;
  quantity_adjustment: number;
  quantity_after: number;
  unit_cost: number | null;
  notes: string | null;
  created_at: string;
  products?: {
    id: string;
    name: string;
    sku: string | null;
  };
}

export interface CreateStockMovementInput {
  product_id: string;
  /**
   * REQUIRED. Per ARCHITECTURE.md, every manual stock movement must be
   * attributed to a specific warehouse. The DB trigger derives branch_id
   * from this warehouse and rejects mismatches with the row's branch_id.
   */
  warehouse_id: string;
  movement_type: StockMovement['movement_type'];
  quantity: number;
  unit_cost?: number;
  reference_type?: string;
  reference_id?: string;
  notes?: string;
  movement_date?: string;
}

export interface CreateStockAdjustmentInput {
  reason: string;
  notes?: string;
  items: {
    product_id: string;
    /**
     * REQUIRED. Without a warehouse the per-warehouse stock cannot be
     * decremented correctly in a multi-warehouse / multi-branch setup.
     */
    warehouse_id: string;
    quantity_adjustment: number;
    unit_cost?: number;
    notes?: string;
    /**
     * Unit-of-measure provenance. The client sends INTENT only —
     * `packaging_id` + `display_quantity` (or `display_uom_id`). The base
     * quantity is derived server-side by `_uom_normalize_adj_line`; never
     * multiply a pack factor here (ADR 0023 / mem: multi-unit-inventory).
     */
    packaging_id?: string | null;
    display_uom_id?: string | null;
    display_quantity?: number | null;
    /** Lot / batch identity. Required by the server for positive adjustments
     * on lot-tracked products; negative lines are resolved FEFO. */
    lot_number?: string | null;
    serial_number?: string | null;
    /** Expiry of a newly registered lot (expiry-tracked products). */
    expiry_date?: string | null;
    lot_allocations?: unknown[] | null;
  }[];
}

export function useInventory() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id;

  // Fetch stock movements (filtered by branch when one is active)
  const { data: stockMovements = [], isLoading: isLoadingMovements } = useQuery({
    queryKey: ["stock-movements", organizationId, businessId, branchId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];
      let query = supabase
        .from("stock_movements")
        .select(`
          *,
          products(id, name, sku),
          warehouses(id, name)
        `)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("movement_date", { ascending: false })
        .order("created_at", { ascending: false });

      if (branchId) query = query.eq("branch_id", branchId);

      // Increased limit for better history visibility; UI paginates via "Show More"
      query = query.limit(500);

      const { data, error } = await query;
      if (error) throw error;
      return data as StockMovement[];
    },
    enabled: !!organizationId && !!businessId,
  });

  // Fetch stock adjustments (filtered by branch when one is active)
  const { data: stockAdjustments = [], isLoading: isLoadingAdjustments } = useQuery({
    queryKey: ["stock-adjustments", organizationId, businessId, branchId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];
      let query = supabase
        .from("stock_adjustments")
        .select(`
          *,
          stock_adjustment_items(
            *,
            products(id, name, sku)
          )
        `)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("adjustment_date", { ascending: false });

      if (branchId) query = query.eq("branch_id", branchId);

      const { data, error } = await query;
      if (error) throw error;
      return data.map(adj => ({
        ...adj,
        items: adj.stock_adjustment_items
      })) as StockAdjustment[];
    },
    enabled: !!organizationId && !!businessId,
  });

  // Fetch low stock products — branch-true.
  // Per ARCHITECTURE.md, products.stock_quantity is a *company aggregate* and
  // must NOT drive branch-level decisions. Read on-hand from warehouse_stock
  // filtered by (business, branch) so a low-stock alert in branch A doesn't
  // get masked by surplus stock sitting in branch B's warehouse.
  const { data: lowStockProducts = [], isLoading: isLoadingLowStock } = useQuery({
    queryKey: ["low-stock-products", organizationId, businessId, branchId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];

      let stockQuery = supabase
        .from("warehouse_stock")
        .select(`
          product_id,
          warehouse_id,
          quantity,
          reserved_quantity,
          warehouses!inner(id, name, branch_id, business_id),
          products!inner(id, name, sku, reorder_level, reorder_quantity, track_inventory, is_active, business_id)
        `)
        .eq("business_id", businessId)
        .eq("organization_id", organizationId)
        .eq("products.track_inventory", true)
        .eq("products.is_active", true)
        .not("products.reorder_level", "is", null);

      if (branchId) stockQuery = stockQuery.eq("branch_id", branchId);

      const { data, error } = await stockQuery;
      if (error) throw error;

      // Aggregate per (product, warehouse) row — each row IS a branch-scoped quant.
      // Low-stock = on-hand at this warehouse <= product's reorder_level.
      // A product may be low in multiple warehouses; collapse to one row per
      // product (worst warehouse wins) so UI keys stay unique.
      const lowRows = (data || []).filter((row: any) => {
        const reorderLevel = row.products?.reorder_level;
        if (reorderLevel === null || reorderLevel === undefined) return false;
        return (row.quantity ?? 0) <= reorderLevel;
      });

      const byProduct = new Map<string, any>();
      for (const row of lowRows) {
        const existing = byProduct.get(row.products.id);
        if (!existing || (row.quantity ?? 0) < (existing.stock_quantity ?? 0)) {
          byProduct.set(row.products.id, {
            id: row.products.id,
            name: row.products.name,
            sku: row.products.sku,
            stock_quantity: row.quantity ?? 0,
            reserved_quantity: row.reserved_quantity ?? 0,
            reorder_level: row.products.reorder_level,
            reorder_quantity: row.products.reorder_quantity,
            warehouse_id: row.warehouse_id,
            warehouse_name: row.warehouses?.name ?? null,
            branch_id: row.warehouses?.branch_id ?? null,
          });
        }
      }
      return Array.from(byProduct.values());
    },
    enabled: !!organizationId && !!businessId,
  });

  // Create stock movement.
  // Audit L1 cleanup: pre-flight warehouse read is dropped — the
  // `enforce_stock_movement_branch_scope` trigger derives branch_id from the
  // warehouse and rejects company mismatches authoritatively. We pass
  // branch_id: null and let the trigger stamp it.
  const createStockMovement = useMutation({
    mutationFn: async (input: CreateStockMovementInput) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("Select a company before recording stock movements");
      if (!input.warehouse_id) throw new Error("warehouse_id is required for manual stock movements");

      const { data: userData } = await supabase.auth.getUser();

      const { data, error } = await supabase
        .from("stock_movements")
        .insert({
          organization_id: organizationId,
          business_id: businessId,
          // branch_id intentionally null — DB trigger derives it from warehouse
          warehouse_id: input.warehouse_id,
          product_id: input.product_id,
          movement_type: input.movement_type,
          quantity: input.quantity,
          unit_cost: input.unit_cost,
          reference_type: input.reference_type,
          reference_id: input.reference_id,
          notes: input.notes,
          movement_date: input.movement_date || new Date().toISOString(),
          created_by: userData?.user?.id,
        } as any)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
      queryClient.invalidateQueries({ queryKey: ["stock-movements-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["products-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["products-list-stock"] });
      queryClient.invalidateQueries({ queryKey: ["warehouse-stock-totals"] });
      queryClient.invalidateQueries({ queryKey: ["product-warehouse-stock"] });
      queryClient.invalidateQueries({ queryKey: ["stock-levels-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["low-stock-products"] });
      toast.success("Stock movement recorded");
    },
    onError: (error) => {
      toast.error("Failed to record stock movement: " + normalizeError(error).message);
    },
  });

  // Create + smart-route stock adjustment.
  // Calls apply_or_request_stock_adjustment which evaluates approval rules
  // and either auto-applies (posting movements + GL) or stores it as
  // pending_approval. Privileged users (owner/admin) bypass rules.
  const createStockAdjustment = useMutation({
    mutationFn: async (input: CreateStockAdjustmentInput) => {
      if (!organizationId) throw new Error("No organization selected");
      if (!businessId) throw new Error("Select a company before creating adjustments");
      if (!input.items?.length) throw new Error("At least one adjustment item is required");

      // Single-warehouse-per-adjustment invariant (Odoo-style).
      const warehouseIds = Array.from(new Set(input.items.map(i => i.warehouse_id)));
      if (warehouseIds.some(id => !id)) {
        throw new Error("Every adjustment item must specify a warehouse");
      }
      if (warehouseIds.length > 1) {
        throw new Error(
          "All adjustment lines must come from the same warehouse. Use a separate adjustment for each warehouse."
        );
      }
      const headerWarehouseId = warehouseIds[0];

      // Validate the warehouse belongs to the active company and is not in-transit.
      const { data: warehouses, error: whErr } = await supabase
        .from("warehouses")
        .select("id, business_id, branch_id, is_in_transit")
        .in("id", warehouseIds);
      if (whErr) throw whErr;

      const wrongCompany = warehouses?.find(w => w.business_id && w.business_id !== businessId);
      if (wrongCompany) {
        throw new Error("One or more chosen warehouses belong to a different company");
      }
      const transitWh = warehouses?.find(w => w.is_in_transit);
      if (transitWh) {
        throw new Error("Cannot adjust stock in the in-transit warehouse — pick a real warehouse.");
      }
      const headerBranchId =
        warehouses?.[0]?.branch_id ?? branchId ?? null;
      if (!headerBranchId) {
        throw new Error("Cannot create adjustment: no branch could be resolved");
      }

      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id;
      if (!userId) throw new Error("Not authenticated");

      // Race-safe number generation (kept on the client so the existing RPC
      // contract for sequence allocation is preserved).
      const { data: adjustmentNumber, error: numError } = await supabase.rpc(
        "get_next_adjustment_number" as any,
        { p_organization_id: organizationId, p_business_id: businessId }
      );
      if (numError) throw numError;

      // C3 — idempotency key. A retry of the same submit (network glitch,
      // double-click) returns the same adjustment instead of double-posting.
      const clientRequestId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const { data, error } = await supabase.rpc(
        "apply_or_request_stock_adjustment" as any,
        {
          p_input: {
            organization_id: organizationId,
            business_id: businessId,
            branch_id: headerBranchId,
            warehouse_id: headerWarehouseId,
            adjustment_number: adjustmentNumber,
            reason: input.reason,
            notes: input.notes,
            client_request_id: clientRequestId,
            items: input.items.map(i => ({
              product_id: i.product_id,
              warehouse_id: i.warehouse_id,
              quantity_adjustment: i.quantity_adjustment,
              unit_cost: i.unit_cost,
              notes: i.notes,
            })),
          },
          p_user_id: userId,
        }
      );

      if (error) throw error;
      const result = data as any;
      if (!result?.success) {
        throw new Error(result?.error || "Failed to create stock adjustment");
      }
      return result as {
        success: true;
        adjustment_id: string;
        status: "approved" | "pending_approval";
        requires_approval: boolean;
        auto_applied: boolean;
        gl_posted?: boolean;
        rule_id?: string;
        rule_name?: string;
        approval_log_id?: string;
        total_value?: number;
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] });
      queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
      queryClient.invalidateQueries({ queryKey: ["stock-movements-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["products-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["products-list-stock"] });
      queryClient.invalidateQueries({ queryKey: ["warehouse-stock-totals"] });
      queryClient.invalidateQueries({ queryKey: ["product-warehouse-stock"] });
      queryClient.invalidateQueries({ queryKey: ["stock-levels-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["low-stock-products"] });
      if (result.requires_approval) {
        toast.info(
          `Stock adjustment submitted for approval${result.rule_name ? ` (rule: ${result.rule_name})` : ""}`
        );
      } else if (result.gl_posted) {
        toast.success("Stock adjustment applied · journal entry posted");
      } else {
        // Should be unreachable now that the server raises on missing cost,
        // but kept as a loud warning if it ever happens.
        toast.warning(
          "Stock adjustment applied but NO journal entry was posted. Inventory and accounting may diverge — review immediately."
        );
      }
    },
    onError: (error) => {
      toast.error("Failed to create stock adjustment: " + normalizeError(error).message);
    },
  });

  // Approve stock adjustment — atomic via DB RPC
  const approveStockAdjustment = useMutation({
    mutationFn: async (adjustmentId: string) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id;
      if (!userId) throw new Error("Not authenticated");

      // Atomic: creates movements + updates status + GL posting in one transaction
      const { data, error } = await supabase.rpc(
        "approve_stock_adjustment_atomic" as any,
        {
          p_adjustment_id: adjustmentId,
          p_user_id: userId,
        }
      );

      if (error) throw error;
      const result = data as any;
      if (!result?.success) {
        throw new Error(result?.error || "Failed to approve adjustment");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] });
      queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
      queryClient.invalidateQueries({ queryKey: ["stock-movements-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["products-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["products-list-stock"] });
      queryClient.invalidateQueries({ queryKey: ["warehouse-stock-totals"] });
      queryClient.invalidateQueries({ queryKey: ["product-warehouse-stock"] });
      queryClient.invalidateQueries({ queryKey: ["stock-levels-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["low-stock-products"] });
      toast.success("Stock adjustment approved");
    },
    onError: (error) => {
      toast.error("Failed to approve adjustment: " + normalizeError(error).message);
    },
  });

  // Cancel stock adjustment — defensive scope so a stale (org/business)
  // context cannot reach across tenants even if RLS is misconfigured.
  const cancelStockAdjustment = useMutation({
    mutationFn: async (adjustmentId: string) => {
      if (!organizationId || !businessId) {
        throw new Error("Select a company before cancelling adjustments");
      }
      const { error } = await supabase
        .from("stock_adjustments")
        .update({ status: "cancelled" })
        .eq("id", adjustmentId)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] });
      toast.success("Stock adjustment cancelled");
    },
    onError: (error) => {
      toast.error("Failed to cancel adjustment: " + normalizeError(error).message);
    },
  });

  // Wave 2 D2 — first-class reversal of an approved adjustment.
  const reverseStockAdjustment = useMutation({
    mutationFn: async (input: { adjustmentId: string; reason: string }) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id;
      if (!userId) throw new Error("Not authenticated");
      const clientRequestId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { data, error } = await supabase.rpc(
        "reverse_stock_adjustment_atomic" as any,
        {
          p_adjustment_id: input.adjustmentId,
          p_user_id: userId,
          p_reversal_reason: input.reason,
          p_client_request_id: clientRequestId,
        },
      );
      if (error) throw error;
      const result = data as any;
      if (!result?.success) {
        throw new Error(result?.error || "Failed to reverse adjustment");
      }
      return result as {
        success: true;
        reversal_id: string;
        reversed_adjustment_id?: string;
        gl_posted?: boolean;
        idempotent?: boolean;
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] });
      queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
      queryClient.invalidateQueries({ queryKey: ["stock-movements-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["products-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["warehouse-stock-totals"] });
      queryClient.invalidateQueries({ queryKey: ["product-warehouse-stock"] });
      queryClient.invalidateQueries({ queryKey: ["stock-levels-paginated"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-reconciliation"] });
      queryClient.invalidateQueries({ queryKey: ["adjustments-missing-je"] });
      if (result.idempotent) {
        toast.info("Reversal already posted (idempotent retry)");
      } else if (result.gl_posted) {
        toast.success("Stock adjustment reversed · mirror journal entry posted");
      } else {
        toast.warning(
          "Reversal applied but NO journal entry was posted. Inventory and accounting may diverge — review immediately.",
        );
      }
    },
    onError: (error) => {
      toast.error("Failed to reverse adjustment: " + normalizeError(error).message);
    },
  });

  return {
    stockMovements,
    stockAdjustments,
    lowStockProducts,
    isLoading: isLoadingMovements || isLoadingAdjustments || isLoadingLowStock,
    createStockMovement,
    createStockAdjustment,
    approveStockAdjustment,
    cancelStockAdjustment,
    reverseStockAdjustment,
  };
}

/**
 * G10 — surface approved adjustments that never produced a journal entry
 * (a side-effect of the pre-fix code path before Phase A+B). The reconciliation
 * card lists each row with a per-row "Post JE now" button that calls
 * backfill_missing_adjustment_je. Strictly opt-in, finance-driven.
 */
export interface MissingAdjustmentJournal {
  id: string;
  adjustment_number: string;
  adjustment_date: string;
  reason: string;
  status: StockAdjustment["status"];
}

export function useMissingAdjustmentJournals() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  return useQuery({
    queryKey: ["adjustments-missing-je", orgId, businessId, branchId],
    queryFn: async (): Promise<MissingAdjustmentJournal[]> => {
      if (!orgId || !businessId) return [];
      // ADR 0016 — server-side NOT EXISTS detector. Avoids the client
      // pagination drift the previous JS-side filter was vulnerable to.
      const { data, error } = await supabase.rpc(
        "list_adjustments_missing_journals" as any,
        {
          p_organization_id: orgId,
          p_business_id: businessId,
          p_branch_id: branchId,
          p_limit: 100,
          p_offset: 0,
        },
      );
      if (error) throw error;
      return (data ?? []) as MissingAdjustmentJournal[];
    },
    enabled: !!orgId && !!businessId,
    staleTime: 60_000,
  });
}

export function useBackfillAdjustmentJE() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (adjustmentId: string) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id;
      if (!userId) throw new Error("Not authenticated");
      const { data, error } = await supabase.rpc(
        "backfill_missing_adjustment_je" as any,
        { p_adjustment_id: adjustmentId, p_user_id: userId },
      );
      if (error) throw error;
      const result = data as any;
      if (!result?.success) {
        throw new Error(result?.error || "Backfill failed");
      }
      return result as { success: true; journal_entry_id: string; total_value: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adjustments-missing-je"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-reconciliation"] });
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      toast.success("Journal entry posted for missing adjustment");
    },
    onError: (error) => {
      toast.error("Backfill failed: " + normalizeError(error).message);
    },
  });
}

/**
 * Wave 5 G6 — read-only preview of which GL offset account the chosen
 * reason will hit, so the operator sees it in the adjustment dialog
 * before submitting. Pure transparency — no behaviour change.
 */
export interface OffsetAccountPreview {
  account_id: string;
  account_code: string;
  account_name: string;
}

export function useOffsetAccountPreview(reason: string | null | undefined) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["offset-account-preview", businessId, reason],
    queryFn: async (): Promise<OffsetAccountPreview | null> => {
      if (!businessId || !reason) return null;
      const { data, error } = await supabase.rpc(
        "preview_adjustment_offset_account" as any,
        { p_business_id: businessId, p_reason: reason, p_sign: 1 },
      );
      if (error) throw error;
      const rows = (data ?? []) as OffsetAccountPreview[];
      return rows[0] ?? null;
    },
    enabled: !!businessId && !!reason,
    staleTime: 5 * 60_000,
  });
}

/**
 * Wave 6 — per-row backfill history for the "missing JE" reconciliation
 * card. Reads from `stock_adjustment_backfill_log` (RLS already restricts
 * visibility to members of the business). Read-only audit surface — no
 * mutations.
 */
export interface AdjustmentBackfillLogEntry {
  id: string;
  adjustment_id: string;
  journal_entry_id: string | null;
  posted_by: string | null;
  posted_at: string;
  total_value: number;
  reason: string | null;
  note: string | null;
  posted_by_name?: string | null;
}

export function useAdjustmentBackfillHistory(
  adjustmentId: string | null | undefined,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: ["adjustment-backfill-history", adjustmentId],
    queryFn: async (): Promise<AdjustmentBackfillLogEntry[]> => {
      if (!adjustmentId) return [];
      const { data, error } = await supabase
        .from("stock_adjustment_backfill_log" as any)
        .select("id, adjustment_id, journal_entry_id, posted_by, posted_at, total_value, reason, note")
        .eq("adjustment_id", adjustmentId)
        .order("posted_at", { ascending: false });
      if (error) throw error;
      const rows = ((data ?? []) as any[]) as AdjustmentBackfillLogEntry[];

      // Resolve poster display names (best-effort; missing profile = uuid fallback).
      const posterIds = Array.from(
        new Set(rows.map((r) => r.posted_by).filter((v): v is string => !!v)),
      );
      if (posterIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, full_name, email")
          .in("id", posterIds);
        const byId = new Map<string, { name: string }>(
          (profiles ?? []).map((p: any) => [
            p.id,
            { name: p.full_name || p.email || p.id },
          ]),
        );
        rows.forEach((r) => {
          r.posted_by_name = r.posted_by
            ? byId.get(r.posted_by)?.name ?? r.posted_by
            : null;
        });
      }
      return rows;
    },
    enabled: !!adjustmentId && enabled,
    staleTime: 30_000,
  });
}

/**
 * Phase F — Server-side count of pending stock adjustments.
 *
 * The smart-routing RPC writes status `pending_approval` (and sometimes
 * `draft`). Doing the count server-side avoids both the in-memory 500-row cap
 * and the wrong-string filter that previously kept the dashboard counter at 0.
 */
export function usePendingAdjustmentsCount() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  return useQuery({
    queryKey: ["pending-adjustments-count", orgId, businessId, branchId],
    queryFn: async () => {
      if (!orgId || !businessId) return 0;
      let q = supabase
        .from("stock_adjustments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .in("status", ["draft", "pending_approval"]);
      if (branchId) q = q.eq("branch_id", branchId);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!orgId && !!businessId,
    staleTime: 30_000,
  });
}

/**
 * Phase F — Server-side counts of today's inbound vs outbound stock movements.
 *
 * The dashboard previously derived these from the in-memory `stockMovements`
 * array which is capped at 500 rows. On busy companies the counter lied.
 * Two `count: 'exact'` queries are O(1) network and never undercount.
 */
const INBOUND_MOVEMENT_TYPES = ["purchase", "receipt", "return_in", "opening", "pos_return"];
const OUTBOUND_MOVEMENT_TYPES = ["sale", "delivery", "return_out", "transfer", "scrap", "pos_sale"];

export function useTodayMovementCounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  return useQuery({
    queryKey: ["today-movement-counts", orgId, businessId, branchId],
    queryFn: async () => {
      if (!orgId || !businessId) return { inbound: 0, outbound: 0, total: 0 };
      const todayIso = new Date().toISOString().slice(0, 10);
      const base = () => {
        let q = supabase
          .from("stock_movements")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("business_id", businessId)
          .gte("movement_date", todayIso);
        if (branchId) q = q.eq("branch_id", branchId);
        return q;
      };
      const [{ count: inbound, error: inErr }, { count: outbound, error: outErr }] =
        await Promise.all([
          base().in("movement_type", INBOUND_MOVEMENT_TYPES),
          base().in("movement_type", OUTBOUND_MOVEMENT_TYPES),
        ]);
      if (inErr) throw inErr;
      if (outErr) throw outErr;
      const i = inbound ?? 0;
      const o = outbound ?? 0;
      return { inbound: i, outbound: o, total: i + o };
    },
    enabled: !!orgId && !!businessId,
    staleTime: 30_000,
  });
}
