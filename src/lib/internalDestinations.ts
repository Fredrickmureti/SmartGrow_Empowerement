/**
 * internalDestinations — resolution of OUR OWN receiving / dispatch
 * locations (branches and warehouses).
 *
 * Deliberately separate from `src/lib/contactAddresses.ts`. A Purchase
 * Order's "Deliver to" is a location of ours — the place we ask the
 * supplier to deliver to — and is NEVER a contact address. Conflating
 * the two is the mistake this module exists to prevent.
 *
 * Internal *stock* locations (bins, zones) remain the WMS's concern via
 * `destination_location_id`; this module stops at the postal level.
 */
import { supabase } from "@/integrations/supabase/client";
import { formatAddress } from "./contactAddresses";

export type InternalDestinationKind = "warehouse" | "branch";

export interface InternalDestination {
  kind: InternalDestinationKind;
  id: string;
  name: string;
  code: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

/** Formats a destination the way a printed PO shows it. */
export function formatInternalDestination(
  destination: InternalDestination | null | undefined,
): string {
  if (!destination) return "";
  const body = formatAddress({
    address_line1: destination.address_line1,
    city: destination.city,
    state: destination.state,
    postal_code: destination.postal_code,
    country: destination.country,
  });
  return [destination.name, body].filter(Boolean).join("\n");
}

/**
 * Every place goods can be delivered to for the active business:
 * warehouses first (the usual receiving point), then branches.
 * RLS scopes the read, so a cross-business id cannot be listed.
 */
export async function listInternalDestinations(
  businessId: string | null | undefined,
): Promise<InternalDestination[]> {
  if (!businessId) return [];

  const [warehouses, branches] = await Promise.all([
    supabase
      .from("warehouses")
      .select("id, name, code, address, city, country")
      .eq("business_id", businessId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("branches")
      .select("id, name, code, address, city, state, postal_code, country")
      .eq("business_id", businessId)
      .eq("is_active", true)
      .order("name"),
  ]);

  if (warehouses.error) throw warehouses.error;
  if (branches.error) throw branches.error;

  return [
    ...(warehouses.data ?? []).map((w: any) => ({
      kind: "warehouse" as const,
      id: w.id,
      name: w.name,
      code: w.code ?? null,
      address_line1: w.address ?? null,
      city: w.city ?? null,
      state: null,
      postal_code: null,
      country: w.country ?? null,
    })),
    ...(branches.data ?? []).map((b: any) => ({
      kind: "branch" as const,
      id: b.id,
      name: b.name,
      code: b.code ?? null,
      address_line1: b.address ?? null,
      city: b.city ?? null,
      state: b.state ?? null,
      postal_code: b.postal_code ?? null,
      country: b.country ?? null,
    })),
  ];
}

/** Stable option value used by the picker (`warehouse:<id>`). */
export function destinationKey(destination: InternalDestination): string {
  return `${destination.kind}:${destination.id}`;
}

export function findDestinationByKey(
  destinations: InternalDestination[],
  key: string | null | undefined,
): InternalDestination | null {
  if (!key) return null;
  return destinations.find((d) => destinationKey(d) === key) ?? null;
}
