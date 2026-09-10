/**
 * Clients Provider
 *
 * Searches the microfinance client register (`mf_clients`) by name, client
 * number, phone or email. The inherited ERP `contacts` table is retired —
 * clients are the only party register in this institution.
 *
 * RLS on `mf_clients` already enforces scoped access, so no extra permission
 * filtering is needed here.
 */

import { Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { CommandEntry } from "../types";
import type { CommandProvider, ProviderContext } from "./types";

async function fetchCustomers(
  query: string,
  ctx: ProviderContext,
): Promise<CommandEntry[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`;

  const { data, error } = await supabase
    .from("mf_clients")
    .select("id, full_name, client_number, phone, email")
    .or(
      `full_name.ilike.${pattern},client_number.ilike.${pattern},phone.ilike.${pattern},email.ilike.${pattern}`,
    )
    .limit(8)
    .abortSignal(ctx.signal);

  if (error || !data) return [];

  return data.map((c) => ({
    id: `record:client:${c.id}`,
    kind: "record" as const,
    title: c.full_name,
    subtitle: c.client_number || c.phone || c.email || "Client",
    appId: "lending",
    icon: Users,
    keywords: [c.full_name, c.client_number ?? "", c.phone ?? "", c.email ?? ""]
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
    weight: 50,
    to: `/lending?client=${c.id}`,
  }));
}

export const customersProvider: CommandProvider = {
  id: "records:customers",
  label: "Clients",
  minQueryLength: 2,
  debounceMs: 150,
  limit: 8,
  fetch: fetchCustomers,
};
