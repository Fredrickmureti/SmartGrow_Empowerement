import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useToast } from "./use-toast";
import { assertCompanyScoped, assertBranchScoped } from "@/lib/purchases/scopingAssertions";
import { applyBranchFilter } from "@/lib/branchScope";
import { normalizeError } from "@/services/resilience";
import type { PurchaseReturnKind, PurchaseReturnStatus } from "@/lib/purchases/purchaseReturnRpcs";

/**
 * usePurchaseReturns — READ side only.
 *
 * Every mutation moved to `src/lib/purchases/purchaseReturnRpcs.ts` when the
 * purchase-return lifecycle became server-authoritative: the browser has
 * SELECT only on `purchase_returns` / `purchase_return_items`, numbering is
 * business-scoped and lock-based, stock leaves at dispatch, and the vendor
 * debit note is raised by `purchase_return_raise_credit`. Do not reintroduce
 * client-side inserts, status flips, stock movements or GL here.
 */

export interface PurchaseReturnItem {
  id?: string;
  purchase_return_id?: string;
  goods_receipt_item_id?: string | null;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  unit_cost_basis?: number | null;
  tax_rate?: number | null;
  tax_amount?: number | null;
  line_total: number;
  sort_order: number;
  return_reason?: string | null;
  condition?: string | null;
  lot_number?: string | null;
  serial_number?: string | null;
  location_id?: string | null;
  // UoM provenance — `quantity` stays in base units (DB trigger normalizes).
  packaging_id?: string | null;
  display_quantity?: number | null;
  display_uom_id?: string | null;
  uom_snapshot?: string | null;
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
  reason_code?: string | null;
  status: PurchaseReturnStatus;
  return_kind?: PurchaseReturnKind | null;
  row_version: number;
  subtotal?: number | null;
  tax_amount?: number | null;
  total: number;
  currency?: string | null;
  exchange_rate?: number | null;
  notes: string | null;
  purchase_order_id: string | null;
  goods_receipt_id?: string | null;
  bill_id?: string | null;
  warehouse_id?: string | null;
  wms_return_order_id?: string | null;
  vendor_credit_note_id?: string | null;
  approval_request_id?: string | null;
  rma_reference?: string | null;
  submitted_at?: string | null;
  approved_at?: string | null;
  rejected_at?: string | null;
  dispatched_at?: string | null;
  acknowledged_at?: string | null;
  credited_at?: string | null;
  closed_at?: string | null;
  cancelled_at?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  journal_entry_id?: string | null;
  vendor?: { name: string; email?: string | null } | null;
  items?: PurchaseReturnItem[];
}

export function usePurchaseReturns() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { toast } = useToast();
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
          vendor:contacts(name, email),
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
    } catch (error: unknown) {
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

  return {
    purchaseReturns,
    isLoading,
    refreshPurchaseReturns: fetchPurchaseReturns,
  };
}
