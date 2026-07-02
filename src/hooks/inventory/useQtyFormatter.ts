/**
 * useQtyFormatter — batched, pack-aware quantity formatter for inventory
 * reports. Looks up product_packaging rows once per report render (single
 * query) and returns a stable formatter the report rows call per cell.
 *
 * Avoids the N+1 trap that plain per-row calls to formatBaseQtyAsPacks would
 * create when reports contain hundreds of products.
 *
 * Consumers control display mode via the workspace setting
 * `inventory.display_packs_in_reports` (default true). The hook honours an
 * explicit `mode` override so reports can offer a per-screen toggle.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { formatBaseQtyAsPacks, type PackForRollup } from "@/lib/packagingRollup";

type Mode = "packs" | "base";

interface Params {
  productIds: ReadonlyArray<string>;
  baseUnitLabelByProduct?: Record<string, string>;
  mode?: Mode;
}

interface QtyFormatter {
  format(productId: string, baseQty: number): string;
  formatWithBase(productId: string, baseQty: number): string;
  isReady: boolean;
}

export function useQtyFormatter({
  productIds,
  baseUnitLabelByProduct,
  mode = "packs",
}: Params): QtyFormatter {
  const uniqueIds = useMemo(
    () => Array.from(new Set(productIds.filter(Boolean))).sort(),
    [productIds],
  );

  const { data, isLoading } = useQuery({
    queryKey: ["product-packaging-batch", uniqueIds, mode],
    enabled: mode === "packs" && uniqueIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("product_packaging")
        .select("product_id, name, qty_in_base_uom")
        .in("product_id", uniqueIds);
      if (error) throw error;
      const byProduct = new Map<string, PackForRollup[]>();
      for (const r of rows ?? []) {
        const list = byProduct.get(r.product_id) ?? [];
        list.push({ name: r.name, qty_in_base_uom: Number(r.qty_in_base_uom) });
        byProduct.set(r.product_id, list);
      }
      return byProduct;
    },
  });

  const format = useCallback(
    (productId: string, baseQty: number): string => {
      const label = baseUnitLabelByProduct?.[productId] ?? "ea";
      if (mode === "base" || !data) {
        const n = Number.isFinite(baseQty) ? Number(baseQty.toFixed(3)).toString() : "0";
        return `${n} ${label}`;
      }
      const packs = data.get(productId) ?? [];
      if (packs.length === 0) {
        const n = Number.isFinite(baseQty) ? Number(baseQty.toFixed(3)).toString() : "0";
        return `${n} ${label}`;
      }
      return formatBaseQtyAsPacks(baseQty, packs, label);
    },
    [data, mode, baseUnitLabelByProduct],
  );

  const formatWithBase = useCallback(
    (productId: string, baseQty: number): string => {
      const label = baseUnitLabelByProduct?.[productId] ?? "ea";
      const packs = data?.get(productId) ?? [];
      const baseStr = `${Number(baseQty.toFixed(3)).toString()} ${label}`;
      if (mode === "base" || packs.length === 0) return baseStr;
      const packStr = formatBaseQtyAsPacks(baseQty, packs, label);
      if (packStr === baseStr) return baseStr;
      return `${packStr} (${baseStr})`;
    },
    [data, mode, baseUnitLabelByProduct],
  );

  return {
    format,
    formatWithBase,
    isReady: mode === "base" || !isLoading,
  };
}
