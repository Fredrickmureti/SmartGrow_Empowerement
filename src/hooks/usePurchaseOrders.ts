import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { usePermissions } from "./usePermissions";
import { assertCompanyScoped, assertBranchScoped } from "@/lib/purchases/scopingAssertions";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";

export interface PurchaseOrderItem {
  id?: string;
  purchase_order_id?: string;
  product_id: string | null;
  description: string;
  quantity: number;
  quantity_received: number;
  quantity_billed?: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number;
  line_total: number;
  sort_order: number;
  // UoM provenance — `quantity` stays in base units (DB trigger normalizes).
  packaging_id?: string | null;
  display_quantity?: number | null;
  display_uom_id?: string | null;
}

/**
 * The PO lifecycle is owned by the database (`po_status` enum + the
 * *_purchase_order RPCs). The UI never invents a status string — it asks the
 * state machine to make a transition and re-reads the result.
 */
export type PurchaseOrderStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "sent"
  | "acknowledged"
  | "partial_received"
  | "received"
  | "closed"
  | "revised"
  | "cancelled";

export interface PurchaseOrder {
  id: string;
  organization_id: string;
  business_id?: string | null;
  branch_id?: string | null;
  vendor_id: string | null;
  po_number: string;
  status: PurchaseOrderStatus;
  billing_status?: "no" | "to_bill" | "fully_billed";
  order_date: string;
  expected_date: string | null;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  currency: string;
  shipping_address: string | null;
  /** OUR receiving location — never the supplier's address. */
  deliver_to_warehouse_id?: string | null;
  deliver_to_branch_id?: string | null;
  deliver_to_warehouse?: { name: string } | null;
  deliver_to_branch?: { name: string } | null;
  notes: string | null;
  converted_bill_id: string | null;
  converted_at: string | null;
  project_id?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  vendor?: { name: string } | null;
  items?: PurchaseOrderItem[];
}

export function usePurchaseOrders() {
  const { currentOrg } = useOrganization();
  const { currentBranch } = useBranch();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { can } = usePermissions();
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPurchaseOrders = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setPurchaseOrders([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      let q = supabase
        .from("purchase_orders")
        .select(`
          *,
          vendor:contacts(name),
          items:purchase_order_items(*)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("order_date", { ascending: false });
      q = applyBranchFilter(q, currentBranch?.id ?? null);
      const { data, error } = await q;

      if (error) throw error;
      const rows = (data as unknown as PurchaseOrder[]) || [];
      // Dev-only contamination guards (parity with useBills).
      assertCompanyScoped(rows, currentBusiness.id, "usePurchaseOrders.fetchPurchaseOrders");
      assertBranchScoped(rows, currentBranch?.id ?? null, "usePurchaseOrders.fetchPurchaseOrders");
      setPurchaseOrders(rows);
    } catch (error: any) {
      console.error("Error fetching purchase orders:", error);
      toast({
        title: "Error loading purchase orders",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id, toast]);

  useEffect(() => {
    fetchPurchaseOrders();
  }, [fetchPurchaseOrders]);

  const getNextPONumber = async (): Promise<string> => {
    if (!currentOrg) throw new Error("No organization selected");

    const { data, error } = await supabase.rpc("get_next_po_number", {
      _org_id: currentOrg.id,
    });

    if (error) throw error;
    return data;
  };

  const createPurchaseOrder = async (
    po: Omit<PurchaseOrder, "id" | "organization_id" | "created_at" | "updated_at" | "created_by" | "vendor" | "items" | "deliver_to_warehouse" | "deliver_to_branch">,
    items: Omit<PurchaseOrderItem, "id" | "purchase_order_id">[]
  ) => {

    if (!can("managePurchases")) { toast({ title: "Permission denied", description: "You don't have permission to create purchase orders", variant: "destructive" }); throw new Error("Permission denied"); }
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization or business selected");

    const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
    const taxAmount = items.reduce((sum, item) => sum + item.tax_amount, 0);
    const total = subtotal + taxAmount - (po.discount_amount || 0);

    // Branch-isolation guard: if a branch is active and caller passed a different
    // branch_id (tampered/stale payload), refuse to write into a sibling branch.
    const callerBranchId = (po as any).branch_id ?? null;
    if (currentBranch?.id && callerBranchId && callerBranchId !== currentBranch.id) {
      throw new Error("Branch mismatch: cannot create purchase order for a different branch.");
    }
    const effectiveBranchId = callerBranchId ?? currentBranch?.id ?? null;

    const { data: created, error: poError } = await supabase
      .from("purchase_orders")
      .insert({
        ...po,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: effectiveBranchId,
        created_by: user.id,
        subtotal,
        tax_amount: taxAmount,
        total,
      })
      .select()
      .single();

    if (poError) throw poError;

    if (items.length > 0) {
      const itemsToInsert = items.map((item, index) => ({
        ...item,
        purchase_order_id: created.id,
        sort_order: index,
      }));

      const { error: itemsError } = await supabase
        .from("purchase_order_items")
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;
    }

    // Optimistic update
    setPurchaseOrders((prev) => [created as unknown as PurchaseOrder, ...prev]);

    // Audit log
    logAction({
      action: "created",
      entityType: "purchase_order",
      entityId: created.id,
      entityName: po.po_number,
      changesSummary: `Created PO ${po.po_number} for ${total}`,
    });

    return created;
  };

  const updatePurchaseOrder = async (
    id: string,
    updates: Partial<PurchaseOrder>,
    items?: Omit<PurchaseOrderItem, "id" | "purchase_order_id">[]
  ) => {
    if (!can("managePurchases")) { toast({ title: "Permission denied", description: "You don't have permission to update purchase orders", variant: "destructive" }); throw new Error("Permission denied"); }
    if (items) {
      const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
      const taxAmount = items.reduce((sum, item) => sum + item.tax_amount, 0);
      const total = subtotal + taxAmount - (updates.discount_amount || 0);

      updates.subtotal = subtotal;
      updates.tax_amount = taxAmount;
      updates.total = total;

      // Use atomic RPC to prevent data loss if insert fails after delete
      const itemsPayload = items.map((item, index) => ({
        ...item,
        sort_order: index,
      }));

      const { error: atomicError } = await supabase.rpc("update_po_items_atomic", {
        p_purchase_order_id: id,
        p_items: itemsPayload,
      });

      if (atomicError) throw atomicError;
    }

    // Strip joined fields. `status` is deliberately stripped too: the lifecycle
    // belongs to the DB state machine, not to a raw column write. Use the
    // transition helpers below instead.
    const { items: _i, vendor, status: _status, ...dbUpdates } = updates as any;
    if (_status !== undefined) {
      console.warn(
        "[usePurchaseOrders] Ignoring status in updatePurchaseOrder — use a lifecycle transition (submit/approve/release/…) instead.",
      );
    }

    const { error } = await supabase
      .from("purchase_orders")
      .update(dbUpdates)
      .eq("id", id);

    if (error) throw error;
    
    // Audit log
    const po = purchaseOrders.find((p) => p.id === id);
    if (po) {
      logAction({
        action: "updated",
        entityType: "purchase_order",
        entityId: id,
        entityName: po.po_number,
        changesSummary: `Updated PO ${po.po_number}`,
      });
    }

    // Optimistic update
    setPurchaseOrders((prev) => prev.map((po) => (po.id === id ? { ...po, ...updates } : po)));
  };

  const deletePurchaseOrder = async (id: string) => {
    if (!can("managePurchases")) { toast({ title: "Permission denied", description: "You don't have permission to delete purchase orders", variant: "destructive" }); throw new Error("Permission denied"); }
    const po = purchaseOrders.find((p) => p.id === id);

    // Status guard: only draft POs can be deleted
    if (po && po.status !== "draft") {
      toast({ title: "Cannot delete", description: `Only draft purchase orders can be deleted. Current status: ${po.status}`, variant: "destructive" });
      throw new Error(`Cannot delete PO with status: ${po.status}`);
    }
    
    // Optimistic update
    setPurchaseOrders((prev) => prev.filter((p) => p.id !== id));

    try {
      const { error } = await supabase.from("purchase_orders").delete().eq("id", id);
      if (error) throw error;

      // Audit log
      if (po) {
        logAction({
          action: "deleted",
          entityType: "purchase_order",
          entityId: id,
          entityName: po.po_number,
          changesSummary: `Deleted PO ${po.po_number}`,
        });
      }
    } catch (error) {
      // Rollback on error
      if (po) {
        setPurchaseOrders((prev) => [...prev, po]);
      }
      throw error;
    }
  };

  /**
   * Convert a PO to a draft Bill atomically.
   *
   * Single RPC call (`convert_po_to_bill_atomic`) does in one transaction:
   *   - locks the PO and refuses if already converted
   *   - allocates the next bill number with collision retry
   *   - inserts the bill (inheriting branch/business/currency/notes from PO)
   *   - copies every PO line into bill_items, linking purchase_order_item_id
   *     so the 3-way-match trigger can compute received-vs-billed quantities
   *   - marks the PO fully_billed and links converted_bill_id
   *
   * Eliminates the previous risk where bill insert + items insert + mark_po_billed
   * were three separate calls — partial failures left orphan bills or unmarked POs.
   */
  const convertToBill = async (poId: string) => {
    if (!user) throw new Error("Not authenticated");
    const po = purchaseOrders.find((p) => p.id === poId);
    if (!po) throw new Error("Purchase order not found");

    const { data, error } = await supabase.rpc("convert_po_to_bill_atomic" as any, {
      _po_id: poId,
      _user_id: user.id,
    });

    if (error) throw new Error(`Convert to bill failed: ${error.message}`);
    const result = (data ?? {}) as {
      success?: boolean;
      bill_id?: string;
      bill_number?: string;
    };
    if (result.success === false || !result.bill_id) {
      throw new Error("Convert to bill failed (RPC reported failure).");
    }

    logAction({
      action: "updated",
      entityType: "purchase_order",
      entityId: poId,
      entityName: po.po_number,
      changesSummary: `Converted PO ${po.po_number} to bill ${result.bill_number ?? result.bill_id}`,
    });

    // Re-fetch to pick up the PO's new billing_status + the new bill row.
    await fetchPurchaseOrders();
    // Return a minimal bill descriptor for callers that need the new id.
    return { id: result.bill_id, bill_number: result.bill_number } as { id: string; bill_number?: string };
  };

  // -------------------------------------------------------------------
  // Lifecycle transitions — one thin wrapper per state-machine RPC.
  // Every guard (allowed source status, SoD, billing locks, event emission)
  // lives in the database; the client only names the intent.
  // -------------------------------------------------------------------
  const runTransition = useCallback(
    async (
      rpc:
        | "submit_purchase_order"
        | "approve_purchase_order"
        | "reject_purchase_order"
        | "release_purchase_order"
        | "acknowledge_purchase_order"
        | "cancel_purchase_order"
        | "revise_purchase_order"
        | "close_purchase_order",
      args: Record<string, unknown>,
      summary: string,
      poId: string,
    ) => {
      const { data, error } = await supabase.rpc(rpc as any, args as any);
      if (error) throw error;

      const po = purchaseOrders.find((p) => p.id === poId);
      logAction({
        action: "updated",
        entityType: "purchase_order",
        entityId: poId,
        entityName: po?.po_number ?? poId,
        changesSummary: summary.replace("{po}", po?.po_number ?? poId),
      });

      await fetchPurchaseOrders();
      return data as unknown as PurchaseOrder;
    },
    [purchaseOrders, logAction, fetchPurchaseOrders],
  );

  const submitPurchaseOrder = (id: string) =>
    runTransition("submit_purchase_order", { p_po_id: id }, "Submitted PO {po} for approval", id);

  /**
   * `clientRequestId` makes approval idempotent: a retried or double-clicked
   * approval with the same key returns the already-approved order instead of
   * re-emitting the approval event.
   */
  const approvePurchaseOrder = (id: string, clientRequestId?: string) =>
    runTransition(
      "approve_purchase_order",
      { p_po_id: id, p_client_request_id: clientRequestId ?? `po-approve-${id}` },
      "Approved PO {po}",
      id,
    );

  const rejectPurchaseOrder = (id: string, reason: string) =>
    runTransition("reject_purchase_order", { p_po_id: id, p_reason: reason }, "Rejected PO {po}", id);

  /** approved -> sent. Notifies the supplier and tells the warehouse to expect goods. */
  const releasePurchaseOrder = (id: string) =>
    runTransition("release_purchase_order", { p_po_id: id }, "Released PO {po} to supplier", id);

  const acknowledgePurchaseOrder = (id: string, vendorNotes?: string) =>
    runTransition(
      "acknowledge_purchase_order",
      { p_po_id: id, p_vendor_notes: vendorNotes ?? null },
      "Supplier acknowledged PO {po}",
      id,
    );

  const cancelPurchaseOrder = (id: string, reason: string) =>
    runTransition("cancel_purchase_order", { p_po_id: id, p_reason: reason }, "Cancelled PO {po}", id);

  const revisePurchaseOrder = (id: string, reason: string) =>
    runTransition("revise_purchase_order", { p_po_id: id, p_reason: reason }, "Revised PO {po}", id);

  const closePurchaseOrder = (id: string, reason?: string) =>
    runTransition("close_purchase_order", { p_po_id: id, p_reason: reason ?? null }, "Closed PO {po}", id);

  return {
    purchaseOrders,
    isLoading,
    getNextPONumber,
    createPurchaseOrder,
    updatePurchaseOrder,
    deletePurchaseOrder,
    convertToBill,
    submitPurchaseOrder,
    approvePurchaseOrder,
    rejectPurchaseOrder,
    releasePurchaseOrder,
    acknowledgePurchaseOrder,
    cancelPurchaseOrder,
    revisePurchaseOrder,
    closePurchaseOrder,
    refreshPurchaseOrders: fetchPurchaseOrders,
  };
}
