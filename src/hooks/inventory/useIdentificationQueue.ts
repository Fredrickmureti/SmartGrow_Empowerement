/**
 * useIdentificationQueue — level-aware replacement for
 * `useProductsAwaitingBarcode`.
 *
 * Enterprise identification is not "does this product have a barcode".
 * It is "does every packaging level of this product carry a scannable
 * identifier". A milk packet with a GTIN but an unlabelled 6-pack and
 * pallet is NOT identified — the warehouse cannot receive a pallet.
 *
 * Source of truth: the `product_identification_status(business, ids[])`
 * RPC, which projects one row per (product, packaging level) with the
 * identifier count and whether the level has been deliberately waived.
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

interface StatusRow {
  product_id: string;
  packaging_id: string | null;
  level_name: string;
  qty_in_base_uom: number | string;
  sort_qty: number | string;
  identifier_count: number;
  primary_code: string | null;
  is_waived: boolean;
}

interface Args {
  businessId: string | null | undefined;
  search?: string;
  /** Max products scanned for missing levels. */
  limit?: number;
}

export function useIdentificationQueue({ businessId, search, limit = 200 }: Args) {
  return useQuery({
    queryKey: ["identification-queue", businessId, search ?? null, limit],
    enabled: !!businessId,
    queryFn: async (): Promise<IdentificationTarget[]> => {
      let q = supabase
        .from("products")
        .select("id,name,sku,unit_price,image_url,category_id")
        .eq("business_id", businessId!)
        .eq("is_active", true)
        // Flagged items leave the workspace until triaged.
        .is("review_reason", null)
        .order("created_at", { ascending: true })
        .limit(limit);

      if (search && search.trim().length > 0) {
        const s = search.trim().replace(/[,()]/g, " ");
        q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%`);
      }

      const { data: products, error } = await q;
      if (error) throw error;
      const rows = products ?? [];
      if (rows.length === 0) return [];

      const { data: status, error: e2 } = await supabase.rpc(
        "product_identification_status" as any,
        {
          p_business_id: businessId!,
          p_product_ids: rows.map((p) => p.id),
        } as any,
      );
      if (e2) throw e2;

      const byProduct = new Map<string, IdentificationLevel[]>();
      for (const raw of (status ?? []) as StatusRow[]) {
        const list = byProduct.get(raw.product_id) ?? [];
        list.push({
          packagingId: raw.packaging_id,
          levelName: raw.level_name,
          qtyInBaseUom: Number(raw.qty_in_base_uom ?? 1),
          identifierCount: Number(raw.identifier_count ?? 0),
          primaryCode: raw.primary_code,
          isWaived: !!raw.is_waived,
        });
        byProduct.set(raw.product_id, list);
      }

      const targets: IdentificationTarget[] = [];
      for (const p of rows) {
        const ladder = (byProduct.get(p.id) ?? []).sort(
          (a, b) => a.qtyInBaseUom - b.qtyInBaseUom,
        );
        for (const level of ladder) {
          if (level.identifierCount > 0 || level.isWaived) continue;
          targets.push({
            key: `${p.id}:${level.packagingId ?? "base"}`,
            id: p.id,
            name: p.name,
            sku: p.sku,
            unit_price: p.unit_price,
            image_url: p.image_url,
            category_id: p.category_id,
            packagingId: level.packagingId,
            levelName: level.levelName,
            qtyInBaseUom: level.qtyInBaseUom,
            ladder,
          });
        }
      }
      return targets;
    },
    staleTime: 30_000,
  });
}
