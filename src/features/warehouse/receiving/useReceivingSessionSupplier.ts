/**
 * useReceivingSessionSupplier — Phase 8 supplier context for the dock.
 *
 * A receiving session records the inbound document it is working against
 * (`source_doc_type` / `source_doc_id`). Supplier-scoped identifiers — a
 * vendor's own part number — may only resolve when that supplier is known, so
 * the workspace resolves the vendor once per session and hands it to the
 * identity gate and to supplier-code discovery.
 *
 * Read-only: procurement stays the sole writer of purchase orders.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ReceivingSupplierContext {
  supplierId: string | null;
  supplierName: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
}

const EMPTY: ReceivingSupplierContext = {
  supplierId: null,
  supplierName: null,
  purchaseOrderId: null,
  purchaseOrderNumber: null,
};

export function useReceivingSessionSupplier(
  businessId: string | undefined,
  session: { source_doc_type?: string | null; source_doc_id?: string | null } | null | undefined,
): ReceivingSupplierContext {
  const docType = (session?.source_doc_type ?? "").toLowerCase();
  const docId = session?.source_doc_id ?? null;
  const isPo = !!docId && (docType === "purchase_order" || docType === "po");

  const { data } = useQuery({
    queryKey: ["receiving-session-supplier", businessId, docId],
    enabled: !!businessId && isPo,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ReceivingSupplierContext> => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("id, po_number, vendor_id, contacts:vendor_id(name)")
        .eq("id", docId as string)
        .eq("business_id", businessId as string)
        .maybeSingle();
      if (error || !data) return EMPTY;
      const row = data as unknown as {
        id: string;
        po_number: string | null;
        vendor_id: string | null;
        contacts?: { name?: string | null } | null;
      };
      return {
        supplierId: row.vendor_id ?? null,
        supplierName: row.contacts?.name ?? null,
        purchaseOrderId: row.id,
        purchaseOrderNumber: row.po_number ?? null,
      };
    },
  });

  return data ?? EMPTY;
}
