/**
 * Lot genealogy — the ONE client entry point to `trace_lot_genealogy`.
 *
 * Phase 7.4 of the inventory reporting wave. Two surfaces need the backward /
 * forward trace of a batch:
 *
 *   - `src/pages/inventory/LotDetail.tsx` (operational master-data surface)
 *   - the Lot Traceability report drill-down (`LotGenealogyDialog`)
 *
 * Both consume this module, so direction, on-hand distribution and the
 * downstream customer trace have exactly one implementation. The browser never
 * decides whether a movement adds or removes stock and never nets a lot
 * balance — the SECURITY DEFINER RPC owns that, and asserts business access
 * server-side (an unauthorized business raises rather than returning rows).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface LotTimelineRow {
  id: string;
  movement_date: string;
  movement_type: string;
  signed_quantity: number;
  direction: "in" | "out";
  warehouse_id: string | null;
  warehouse_name: string | null;
  reference_type: string | null;
  reference_id: string | null;
  serial_number: string | null;
  notes: string | null;
}

export interface LotDistributionRow {
  warehouse_id: string | null;
  warehouse_name: string;
  quantity: number;
}

export interface LotGenealogy {
  total_on_hand: number;
  distribution: LotDistributionRow[];
  timeline: LotTimelineRow[];
  downstream_customers: unknown[];
  quarantine: unknown[];
}

export interface LotGenealogyKey {
  businessId: string | null | undefined;
  productId: string | null | undefined;
  lotNumber: string | null | undefined;
}

/** Human labels for `stock_movements.reference_type`. */
export const LOT_REFERENCE_LABELS: Record<string, string> = {
  goods_receipt: "Goods Receipt",
  invoice: "Invoice",
  credit_note: "Credit Note",
  sales_return: "Sales Return",
  delivery_note: "Delivery Note",
  stock_transfer: "Stock Transfer",
  stock_adjustment: "Stock Adjustment",
  scrap: "Scrap",
  pos_transaction: "POS Sale",
  purchase_return: "Purchase Return",
  physical_count: "Physical Count",
};

export function lotReferenceLabel(referenceType: string | null | undefined): string {
  if (!referenceType) return "—";
  return LOT_REFERENCE_LABELS[referenceType] ?? referenceType;
}

/**
 * Reference types that resolve to a peekable source document
 * (`SourceDocumentPeekSheet`). Anything else renders as plain text.
 */
export const DRILLABLE_LOT_REFERENCES: ReadonlySet<string> = new Set([
  "purchase_order",
  "goods_receipt",
  "invoice",
  "bill",
  "sales_order",
  "delivery_note",
  "credit_note",
  "sales_return",
  "pos_transaction",
  "stock_adjustment",
  "stock_transfer",
]);

export function isDrillableLotReference(
  referenceType: string | null | undefined,
  referenceId: string | null | undefined,
): boolean {
  return !!referenceType && !!referenceId && DRILLABLE_LOT_REFERENCES.has(referenceType);
}

/**
 * Raw fetch, for callers that already own their loading state
 * (`LotDetail` loads its header imperatively and reuses this).
 */
export async function fetchLotGenealogy(key: LotGenealogyKey): Promise<LotGenealogy | null> {
  const { businessId, productId, lotNumber } = key;
  if (!businessId || !productId || !lotNumber) return null;
  const { data, error } = await supabase.rpc("trace_lot_genealogy" as never, {
    p_business_id: businessId,
    p_product_id: productId,
    p_lot_number: lotNumber,
  } as never);
  if (error) throw error;
  return (data ?? null) as unknown as LotGenealogy | null;
}

/** Query-cached genealogy for a single lot. */
export function useLotGenealogy(key: LotGenealogyKey & { enabled?: boolean }) {
  const { businessId, productId, lotNumber, enabled = true } = key;
  return useQuery({
    queryKey: ["lot-genealogy", businessId, productId, lotNumber],
    queryFn: () => fetchLotGenealogy({ businessId, productId, lotNumber }),
    enabled: enabled && !!businessId && !!productId && !!lotNumber,
    staleTime: 30_000,
  });
}
