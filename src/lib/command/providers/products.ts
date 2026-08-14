/**
 * Products Provider
 *
 * Searches `products` by name or SKU. RLS enforces org scope.
 * Gated by `viewProducts`.
 */

import { Package } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { CommandEntry } from "../types";
import type { CommandProvider, ProviderContext } from "./types";

async function fetchProducts(
  query: string,
  ctx: ProviderContext,
): Promise<CommandEntry[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`;

  const { data, error } = await supabase
    .from("products")
    .select("id, name, sku")
    .or(`name.ilike.${pattern},sku.ilike.${pattern}`)
    .eq("status", "active")
    .limit(8)
    .abortSignal(ctx.signal);

  if (error || !data) return [];

  return data.map((p) => ({
    id: `record:product:${p.id}`,
    kind: "record" as const,
    title: p.name,
    subtitle: p.sku ? `SKU ${p.sku}` : "Product",
    appId: "inventory",
    icon: Package,
    keywords: [p.name.toLowerCase(), (p.sku ?? "").toLowerCase()].filter(Boolean),
    weight: 50,
    to: `/inventory-app/products?selected=${p.id}`,
  }));
}

export const productsProvider: CommandProvider = {
  id: "records:products",
  label: "Products",
  minQueryLength: 2,
  debounceMs: 180,
  limit: 8,
  fetch: fetchProducts,
  permission: "viewProducts",
};
