import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { useGLPosting } from "./useGLPosting";
import { useDefaultAccounts } from "./useDefaultAccounts";
import { assertCompanyScoped, assertBranchScoped } from "@/lib/purchases/scopingAssertions";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";
import { recordStockMovement } from "@/lib/inventory/stockLedger";

export interface PurchaseReturnItem {
  id?: string;
  purchase_return_id?: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  sort_order: number;
  // UoM provenance — `quantity` stays in base units (DB trigger normalizes).
  packaging_id?: string | null;
  display_quantity?: number | null;
  display_uom_id?: string | null;
}

export interface PurchaseReturn {
  id: string;
  organization_id: string;
  business_id?: string | null;
  branch_id?: string | null;
  vendor_id: string | null;
  return_number: string;
  return_date: string;
  reason: string;
  status: "pending" | "approved" | "processed" | "cancelled";
  total: number;
  currency?: string | null;
  notes: string | null;
  purchase_order_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  journal_entry_id?: string | null;
  vendor?: { name: string } | null;
  items?: PurchaseReturnItem[];
}

export function usePurchaseReturns() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { postToGL } = useGLPosting();
  const { accounts, hasRequiredAccounts } = useDefaultAccounts();
  const [purchaseReturns, setPurchaseReturns] = useState<PurchaseReturn[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPurchaseReturns = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setPurchaseReturns([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      let q = supabase
        .from("purchase_returns")
        .select(`
          *,
          vendor:contacts(name),
          items:purchase_return_items(*)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("return_date", { ascending: false });
      q = applyBranchFilter(q, currentBranch?.id ?? null);
      const { data, error } = await q;

      if (error) throw error;
      const rows = (data as unknown as PurchaseReturn[]) || [];
      // Dev-only contamination guards (parity with useBills / usePurchaseOrders).
      assertCompanyScoped(rows, currentBusiness.id, "usePurchaseReturns.fetchPurchaseReturns");
      assertBranchScoped(rows, currentBranch?.id ?? null, "usePurchaseReturns.fetchPurchaseReturns");
      setPurchaseReturns(rows);
    } catch (error: any) {
      console.error("Error fetching purchase returns:", error);
      toast({
        title: "Error loading purchase returns",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id, toast]);

  useEffect(() => {
    fetchPurchaseReturns();
  }, [fetchPurchaseReturns]);

  const getNextReturnNumber = async (): Promise<string> => {
    if (!currentOrg) throw new Error("No organization selected");

    const { data, error } = await supabase.rpc("get_next_purchase_return_number", {
      _org_id: currentOrg.id,
    });

    if (error) throw error;
    return data;
  };

  const createPurchaseReturn = async (
    returnData: Omit<PurchaseReturn, "id" | "organization_id" | "created_at" | "updated_at" | "created_by" | "vendor" | "items" | "return_number">,
    items: Omit<PurchaseReturnItem, "id" | "purchase_return_id">[]
  ) => {
    if (!currentOrg || !currentBusiness || !user) throw new Error("No organization/business selected");

    const returnNumber = await getNextReturnNumber();
    const total = items.reduce((sum, item) => sum + item.line_total, 0);

    const { data: created, error: returnError } = await supabase
      .from("purchase_returns")
      .insert({
        ...returnData,
        return_number: returnNumber,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: currentBranch?.id ?? null,
        created_by: user.id,
        total,
      } as any)
      .select()
      .single();

    if (returnError) throw returnError;

    if (items.length > 0) {
      const itemsToInsert = items.map((item, index) => ({
        ...item,
        purchase_return_id: created.id,
        sort_order: index,
      }));

      const { error: itemsError } = await supabase
        .from("purchase_return_items")
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;
    }

    logAction({
      action: "created",
      entityType: "purchase_return",
      entityId: created.id,
      entityName: returnNumber,
      changesSummary: `Created purchase return ${returnNumber} for ${total}`,
    });

    setPurchaseReturns((prev) => [created as unknown as PurchaseReturn, ...prev]);
    return created;
  };

  // The purchase-return GL posting used to be built here, in the browser.
  // ADR 0132 removed it: `create_vendor_credit_note_atomic` /
  // `issue_vendor_credit_note_atomic` resolve the accounts and build the
  // journal lines server-side, and post only through
  // `post_journal_entry_atomic`. Do not reintroduce a client-side builder.



  /**
   * Update a purchase return status, with side effects:
   * - On "approved": adjust inventory (reduce stock for returned items)
   * - On "processed": create a vendor debit note + post to GL
   */
  const updatePurchaseReturn = async (
    id: string,
    updates: Partial<PurchaseReturn>
  ) => {
    const pr = purchaseReturns.find((p) => p.id === id);

    // Strip joined fields
    const { items: _items, journal_entry_id, purchase_order_id, vendor, ...dbUpdates } = updates as any;

    const { error } = await supabase
      .from("purchase_returns")
      .update(dbUpdates)
      .eq("id", id);

    if (error) throw error;

    // Side effects on status change
    if (updates.status === "approved" && pr?.items && pr.items.length > 0) {
      // Resolve a destination warehouse so the stock_movements trigger can
      // derive branch_id. We use the active branch's default warehouse if
      // available, otherwise the company's default. Refuse the write rather
      // than create branch-NULL movements.
      let returnWarehouseId: string | null = null;
      if (currentBranch?.id && currentBusiness?.id) {
        const { data: wh } = await supabase
          .from("warehouses")
          .select("id")
          .eq("organization_id", currentOrg!.id)
          .eq("business_id", currentBusiness.id)
          .eq("branch_id", currentBranch.id)
          .eq("is_default", true)
          .eq("is_active", true)
          .maybeSingle();
        returnWarehouseId = wh?.id ?? null;
      }
      if (!returnWarehouseId && currentBusiness?.id) {
        const { data: wh } = await supabase
          .from("warehouses")
          .select("id")
          .eq("organization_id", currentOrg!.id)
          .eq("business_id", currentBusiness.id)
          .eq("is_default", true)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();
        returnWarehouseId = wh?.id ?? null;
      }
      if (!returnWarehouseId) {
        throw new Error(
          "Cannot approve return: no default warehouse configured for the active branch/company"
        );
      }
      for (const item of pr.items) {
        if (item.product_id) {
          try {
            // Resolve pack provenance from the originating return line so the
            // ledger remembers HOW the stock left, not just how many base units.
            const { data: src } = await supabase
              .from("purchase_return_items")
              .select("packaging_id, display_uom_id")
              .eq("purchase_return_id", id)
              .eq("product_id", item.product_id)
              .order("created_at", { ascending: true, nullsFirst: false })
              .limit(1)
              .maybeSingle();
            const { error: invError } = await recordStockMovement({
              organization_id: currentOrg!.id,
              business_id: currentBusiness?.id || null,
              product_id: item.product_id,
              movement_type: "return",
              quantity: -item.quantity,
              reference_type: "purchase_return",
              reference_id: id,
              notes: `Purchase return ${pr.return_number} approved - stock reduced`,
              warehouse_id: returnWarehouseId,
              created_by: user!.id,
              source_packaging_id: (src as any)?.packaging_id ?? null,
              source_uom_id: (src as any)?.display_uom_id ?? null,
            } as any);
            if (invError) throw invError;
          } catch (invError) {
            console.error("Inventory adjustment failed for return item:", invError);
          }
        }
      }

      logAction({
        action: "updated",
        entityType: "purchase_return",
        entityId: id,
        entityName: pr.return_number,
        changesSummary: `Approved purchase return ${pr.return_number} — inventory adjusted`,
      });
    }

    if (updates.status === "processed" && pr) {
      // ADR 0132: the vendor credit note for a processed return is created and
      // issued by the canonical writer in one transaction — header, lines,
      // business-scoped number, GL (AP up to the bill's open balance, remainder
      // to Vendor Credits) and the credit movement. No client-side insert, no
      // client-side journal lines, no fallback number. Any failure throws and
      // aborts the status flip.
      const { data: created, error: vcnError } = await supabase.rpc(
        "create_vendor_credit_note_atomic" as any,
        {
          _org_id: currentOrg!.id,
          _business_id: currentBusiness?.id || pr.business_id,
          // Inherit branch from the parent purchase return — NOT active context.
          // A HQ user processing a Branch A return must produce a Branch A credit.
          _branch_id: pr.branch_id ?? currentBranch?.id ?? null,
          _vendor_id: pr.vendor_id,
          _bill_id: (pr as any).bill_id ?? null,
          _credit_date: new Date().toISOString().split("T")[0],
          _notes: `Vendor debit note for purchase return ${pr.return_number}: ${pr.reason}`,
          _items: [
            {
              description: `Purchase return ${pr.return_number}`,
              quantity: 1,
              unit_price: pr.total,
              tax_rate: 0,
              tax_amount: 0,
              line_total: pr.total,
              sort_order: 0,
            },
          ],
          _issue: true,
        }
      );
      if (vcnError) {
        throw new Error(
          `Failed to create vendor debit note for return ${pr.return_number}: ${vcnError.message}`
        );
      }
      const dnNumber = (created as any)?.credit_note_number ?? "";

      logAction({
        action: "created",
        entityType: "purchase_return",
        entityId: id,
        entityName: pr.return_number,
        changesSummary: `Processed return ${pr.return_number} — debit note ${dnNumber} created and posted`,
      });
    }

    
    // Optimistic update
    setPurchaseReturns((prev) => prev.map((p) => (p.id === id ? { ...p, ...updates } : p)));
  };

  const deletePurchaseReturn = async (id: string) => {
    const pr = purchaseReturns.find((p) => p.id === id);

    // Status guard: only pending or cancelled returns can be deleted
    if (pr && ["approved", "processed"].includes(pr.status)) {
      toast({
        title: "Cannot delete",
        description: `Cannot delete a ${pr.status} purchase return. It has associated GL entries and/or stock adjustments.`,
        variant: "destructive",
      });
      throw new Error(`Cannot delete purchase return with status: ${pr.status}`);
    }
    
    setPurchaseReturns((prev) => prev.filter((p) => p.id !== id));

    try {
      const { error } = await supabase.from("purchase_returns").delete().eq("id", id);
      if (error) throw error;

      if (pr) {
        logAction({
          action: "deleted",
          entityType: "purchase_return",
          entityId: id,
          entityName: pr.return_number,
          changesSummary: `Deleted purchase return ${pr.return_number}`,
        });
      }
    } catch (error) {
      if (pr) {
        setPurchaseReturns((prev) => [...prev, pr]);
      }
      throw error;
    }
  };

  /**
   * Edit a pending purchase return (header + items). Only "pending"
   * returns can be edited — once approved/processed, side effects
   * (inventory + GL) are in play and edits must go through a
   * cancellation flow instead.
   */
  const editPurchaseReturn = async (
    id: string,
    header: Partial<Omit<PurchaseReturn, "id" | "organization_id" | "business_id" | "branch_id" | "created_by" | "created_at" | "updated_at" | "journal_entry_id" | "vendor" | "items">>,
    items: Omit<PurchaseReturnItem, "id" | "purchase_return_id">[],
  ) => {
    const existing = purchaseReturns.find((p) => p.id === id);
    if (!existing) throw new Error("Purchase return not found");
    if (existing.status !== "pending") {
      throw new Error("Only pending purchase returns can be edited");
    }

    const { vendor: _v, items: _i, ...dbUpdates } = header as any;
    const { error } = await supabase
      .from("purchase_returns")
      .update(dbUpdates)
      .eq("id", id);
    if (error) throw error;

    const { error: delError } = await supabase
      .from("purchase_return_items")
      .delete()
      .eq("purchase_return_id", id);
    if (delError) throw delError;

    if (items.length > 0) {
      const itemsToInsert = items.map((item, i) => ({
        ...item,
        purchase_return_id: id,
        sort_order: i,
      }));
      const { error: insError } = await supabase
        .from("purchase_return_items")
        .insert(itemsToInsert);
      if (insError) throw insError;
    }

    logAction({
      action: "updated",
      entityType: "purchase_return",
      entityId: id,
      entityName: existing.return_number,
      changesSummary: `Updated purchase return ${existing.return_number}`,
    });

    toast({ title: "Purchase return updated", description: existing.return_number });
    await fetchPurchaseReturns();
  };

  return {
    purchaseReturns,
    isLoading,
    getNextReturnNumber,
    createPurchaseReturn,
    updatePurchaseReturn,
    editPurchaseReturn,
    deletePurchaseReturn,
    refreshPurchaseReturns: fetchPurchaseReturns,
  };
}

