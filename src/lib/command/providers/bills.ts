/**
 * Bills Provider
 *
 * Searches `bills` by bill_number / vendor_invoice_number. RLS on
 * `bills` enforces org scoping. Gated by `viewPurchases`.
 */

import { Receipt } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { CommandEntry } from "../types";
import type { CommandProvider, ProviderContext } from "./types";

async function fetchBills(
  query: string,
  ctx: ProviderContext,
): Promise<CommandEntry[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`;

  const { data, error } = await supabase
    .from("bills")
    .select("id, bill_number, vendor_invoice_number, total, vendor_id, contacts:vendor_id(name)")
    .or(`bill_number.ilike.${pattern},vendor_invoice_number.ilike.${pattern}`)
    .order("created_at", { ascending: false })
    .limit(8)
    .abortSignal(ctx.signal);

  if (error || !data) return [];

  return data.map((b) => {
    const vendorName = (b.contacts as { name?: string } | null)?.name ?? "—";
    return {
      id: `record:bill:${b.id}`,
      kind: "record" as const,
      title: `Bill ${b.bill_number}`,
      subtitle: `${vendorName} · ${b.total}${b.vendor_invoice_number ? ` · ref ${b.vendor_invoice_number}` : ""}`,
      appId: "purchases",
      icon: Receipt,
      keywords: [
        b.bill_number.toLowerCase(),
        vendorName.toLowerCase(),
        (b.vendor_invoice_number ?? "").toLowerCase(),
      ].filter(Boolean),
      weight: 50,
      to: `/purchases/bills?id=${b.id}`,
    };
  });
}

export const billsProvider: CommandProvider = {
  id: "records:bills",
  label: "Bills",
  minQueryLength: 2,
  debounceMs: 180,
  limit: 8,
  fetch: fetchBills,
  permission: "viewPurchases",
};
