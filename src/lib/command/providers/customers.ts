/**
 * Customers / Contacts Provider
 *
 * Searches the `contacts` table by name/email/parent-company with ilike.
 *
 * The legacy `contacts.company` column was removed when contacts were
 * canonicalised on the Odoo model — every contact is now an entity, and
 * "company" for an individual is just their parent_contact's name (joined
 * via `parent_contact_id`). We surface that join here so the search UX
 * still shows the company affiliation.
 *
 * RLS on `contacts` already enforces org-scoped access — no extra
 * permission filtering needed here.
 */

import { Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { applyPartyScope } from "@/lib/contactAddresses";
import type { CommandEntry } from "../types";
import type { CommandProvider, ProviderContext } from "./types";

async function fetchCustomers(
  query: string,
  ctx: ProviderContext,
): Promise<CommandEntry[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`;

  const { data, error } = await applyPartyScope(
    supabase
      .from("contacts")
      .select("id, name, email, parent_contact:contacts!parent_contact_id(name)"),
  )
    .or(`name.ilike.${pattern},email.ilike.${pattern}`)
    .eq("is_active", true)
    .limit(8)
    .abortSignal(ctx.signal);

  if (error || !data) return [];

  return (data as unknown as Array<{
    id: string;
    name: string;
    email: string | null;
    parent_contact: { name: string | null } | null;
  }>).map((c) => {
    const company = c.parent_contact?.name ?? null;
    return {
      id: `record:contact:${c.id}`,
      kind: "record" as const,
      title: c.name,
      subtitle: company || c.email || "Contact",
      appId: "contacts",
      icon: Users,
      keywords: [c.name, c.email ?? "", company ?? ""]
        .filter(Boolean)
        .map((s) => s.toLowerCase()),
      weight: 50,
      to: `/contacts/${c.id}`,
    };
  });
}

export const customersProvider: CommandProvider = {
  id: "records:customers",
  label: "Customers",
  minQueryLength: 2,
  debounceMs: 150,
  limit: 8,
  fetch: fetchCustomers,
};
