/**
 * Invoices Provider
 *
 * Searches the `invoices` table by invoice_number with ilike. Joins
 * the contact name via the FK so users can search by customer too.
 *
 * RLS on `invoices` enforces org-scoped access. We additionally hide
 * the provider when the user lacks `viewSales` — gating happens at
 * registration time via a permission check inside the hook (see
 * useCommandProviders rewrite below).
 */

import { FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { CommandEntry } from "../types";
import type { CommandProvider, ProviderContext } from "./types";

async function fetchInvoices(
  query: string,
  ctx: ProviderContext,
): Promise<CommandEntry[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`;

  const { data, error } = await supabase
    .from("invoices")
    .select("id, invoice_number, total, status, contact_id, contacts(name)")
    .ilike("invoice_number", pattern)
    .order("created_at", { ascending: false })
    .limit(8)
    .abortSignal(ctx.signal);

  if (error || !data) return [];

  return data.map((inv) => {
    const contactName = (inv.contacts as { name?: string } | null)?.name ?? "—";
    return {
      id: `record:invoice:${inv.id}`,
      kind: "record" as const,
      title: `Invoice ${inv.invoice_number}`,
      subtitle: `${contactName} · ${inv.status} · ${inv.total}`,
      appId: "sales",
      icon: FileText,
      keywords: [inv.invoice_number.toLowerCase(), contactName.toLowerCase()],
      weight: 50,
      to: `/sales/invoices?id=${inv.id}`,
    };
  });
}

export const invoicesProvider: CommandProvider = {
  id: "records:invoices",
  label: "Invoices",
  minQueryLength: 2,
  debounceMs: 180,
  limit: 8,
  fetch: fetchInvoices,
  /** Hidden if user lacks viewSales. Honoured by useCommandProviders. */
  permission: "viewSales",
};
