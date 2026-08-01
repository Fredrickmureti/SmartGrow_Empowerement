/**
 * useIdentificationQueue — level-aware replacement for
 * the removed product-level `useProductsAwaitingBarcode` projection.
 *
 * Enterprise identification is not "does this product have a barcode".
 * It is "does every packaging level of this product carry a scannable
 * identifier". A milk packet with a GTIN but an unlabelled 6-pack and
 * pallet is NOT identified — the warehouse cannot receive a pallet.
 *
 * Source of truth: the `product_identification_queue(business, search,
 * limit, offset)` RPC. Completeness filtering, search and paging all run
 * server-side — the client never downloads the catalogue to decide what
 * is missing, so the workspace behaves the same for 200 or 200 000 SKUs.
 *
 * The queue this hook returns is a flat list of *targets* — one entry per
 * missing level — ordered product-by-product, smallest level first, so
 * the operator scans the ladder bottom-up (packet → six-pack → carton →
 * pallet) exactly as the physical goods present themselves.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface IdentificationLevel {
  packagingId: string | null;
  levelName: string;
  qtyInBaseUom: number;
  identifierCount: number;
  primaryCode: string | null;
  isWaived: boolean;
}

export interface IdentificationTarget {
  /** Unique key for the (product, level) pair. */
  key: string;
  id: string; // product id — keeps the reducer contract stable
  name: string;
  sku: string | null;
  unit_price: number;
  image_url: string | null;
  category_id: string | null;
  packagingId: string | null;
  levelName: string;
  qtyInBaseUom: number;
  /** Full ladder for the product, so the UI can show progress in context. */
  ladder: IdentificationLevel[];
}

export interface IdentificationQueueResult {
  targets: IdentificationTarget[];
  /** Total products still missing at least one identifier (ignores paging). */
  pendingProductCount: number;
}

interface QueueRow {
  product_id: string;
  product_name: string;
  sku: string | null;
  unit_price: number | string | null;
  image_url: string | null;
  category_id: string | null;
  packaging_id: string | null;
  level_name: string;
  qty_in_base_uom: number | string;
  identifier_count: number;
  primary_code: string | null;
  is_waived: boolean;
  needs_identifier: boolean;
  pending_product_count: number | string;
}

interface Args {
  businessId: string | null | undefined;
  search?: string;
  /** Products per page (levels are expanded server-side). */
  limit?: number;
  offset?: number;
}

export function useIdentificationQueue({
  businessId,
  search,
  limit = 50,
  offset = 0,
}: Args) {
  return useQuery({
    queryKey: ["identification-queue", businessId, search ?? null, limit, offset],
    enabled: !!businessId,
    queryFn: async (): Promise<IdentificationQueueResult> => {
      const { data, error } = await supabase.rpc(
        "product_identification_queue" as any,
        {
          p_business_id: businessId!,
          p_search: search?.trim() || null,
          p_limit: limit,
          p_offset: offset,
        } as any,
      );
      if (error) throw error;

      const rows = (data ?? []) as QueueRow[];
      if (rows.length === 0) return { targets: [], pendingProductCount: 0 };

      // Preserve server ordering (created_at, then level size ascending).
      const order: string[] = [];
      const meta = new Map<string, QueueRow>();
      const ladders = new Map<string, IdentificationLevel[]>();

      for (const r of rows) {
        if (!meta.has(r.product_id)) {
          meta.set(r.product_id, r);
          order.push(r.product_id);
        }
        const list = ladders.get(r.product_id) ?? [];
        list.push({
          packagingId: r.packaging_id,
          levelName: r.level_name,
          qtyInBaseUom: Number(r.qty_in_base_uom ?? 1),
          identifierCount: Number(r.identifier_count ?? 0),
          primaryCode: r.primary_code,
          isWaived: !!r.is_waived,
        });
        ladders.set(r.product_id, list);
      }

      const targets: IdentificationTarget[] = [];
      for (const productId of order) {
        const p = meta.get(productId)!;
        const ladder = (ladders.get(productId) ?? []).sort(
          (a, b) => a.qtyInBaseUom - b.qtyInBaseUom,
        );
        for (const level of ladder) {
          if (level.identifierCount > 0 || level.isWaived) continue;
          targets.push({
            key: `${productId}:${level.packagingId ?? "base"}`,
            id: productId,
            name: p.product_name,
            sku: p.sku,
            unit_price: Number(p.unit_price ?? 0),
            image_url: p.image_url,
            category_id: p.category_id,
            packagingId: level.packagingId,
            levelName: level.levelName,
            qtyInBaseUom: level.qtyInBaseUom,
            ladder,
          });
        }
      }

      return {
        targets,
        pendingProductCount: Number(rows[0].pending_product_count ?? 0),
      };
    },
    staleTime: 30_000,
  });
}
