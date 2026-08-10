/**
 * contactAddresses — THE canonical party-address resolution layer.
 *
 * Architecture (see ADR-0080):
 *   - A business party is a root `contacts` row (`parent_contact_id IS NULL`).
 *   - Its saved addresses are CHILD `contacts` rows carrying
 *     `child_address_type IN ('contact','invoice','delivery','other')`.
 *     This is the Odoo model the platform already committed to via
 *     ADR-0038 (`parent_contact_id` + `commercial_partner_id`).
 *   - `is_default_shipping` / `is_default_billing` nominate the default
 *     ship-to / bill-to among those children (DB trigger keeps them unique
 *     per parent).
 *   - The party's own row is always the implicit fallback.
 *
 * There is exactly ONE address resolver in this platform. Do not add a
 * second one, and do not hand-roll `address_line1 + city + …` string
 * concatenation in a feature module or a document snapshot builder —
 * import `formatAddress` from here.
 *
 * NOT handled here on purpose: OUR OWN receiving / dispatch destinations.
 * Those are branches and warehouses (`branches.address`,
 * `warehouses.address`) — never contact addresses. See
 * `resolveInternalDestinationAddress` in `src/lib/internalDestinations.ts`.
 */
import { supabase } from "@/integrations/supabase/client";

export type ContactAddressRole = "contact" | "invoice" | "delivery" | "other";

export interface PartyAddress {
  id: string;
  name: string;
  /** Null for the party's own (root) address. */
  child_address_type: ContactAddressRole | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
  is_default_shipping: boolean;
  is_default_billing: boolean;
  /** True for the root party row rather than a saved child address. */
  is_party_itself: boolean;
}

const ADDRESS_COLUMNS =
  "id, name, child_address_type, address_line1, address_line2, city, state, postal_code, country, email, phone, is_default_shipping, is_default_billing";

/** Renders a saved address as the multi-line block documents print. */
export function formatAddress(
  address: Partial<PartyAddress> | null | undefined,
  options: { includeName?: boolean } = {},
): string {
  if (!address) return "";
  const cityLine = [address.city, address.state, address.postal_code]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");

  return [
    options.includeName ? address.name : null,
    address.address_line1,
    address.address_line2,
    cityLine,
    address.country,
  ]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** True when the row carries no usable postal information. */
export function isEmptyAddress(
  address: Partial<PartyAddress> | null | undefined,
): boolean {
  return formatAddress(address).length === 0;
}

/**
 * THE party-scope rule (ADR-0038 / ADR-0080).
 *
 * A `contacts` row carrying `child_address_type` is an ADDRESS of a party,
 * not a party. It must never appear in a contacts list, a customer picker,
 * a vendor picker, a ledger party list, or any other surface where the user
 * is choosing a business relationship — it only appears inside its owning
 * party's address book and in the ship-to / bill-to pickers.
 *
 * Every party read expresses that rule through this one helper:
 *
 *   applyPartyScope(supabase.from("contacts").select("..."))
 *     .eq("organization_id", orgId)
 *
 * Do not hand-roll `.is("child_address_type", null)` at call sites, and do
 * not omit it — `src/test/architecture/contact-party-scope.test.ts` fails
 * the build either way.
 */
export function applyPartyScope<Q extends { is(column: string, value: null): Q }>(
  query: Q,
): Q {
  return query.is("child_address_type", null);
}



function toPartyAddress(row: any, isParty: boolean): PartyAddress {
  return {
    id: row.id,
    name: row.name ?? "",
    child_address_type: (row.child_address_type ?? null) as
      | ContactAddressRole
      | null,
    address_line1: row.address_line1 ?? null,
    address_line2: row.address_line2 ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    postal_code: row.postal_code ?? null,
    country: row.country ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    is_default_shipping: Boolean(row.is_default_shipping),
    is_default_billing: Boolean(row.is_default_billing),
    is_party_itself: isParty,
  };
}

/**
 * Every address selectable for a party: the party's own row first, then
 * its saved child addresses. RLS scopes the read to the caller's
 * business, so a cross-business contact id simply returns nothing.
 */
export async function listPartyAddresses(
  contactId: string | null | undefined,
): Promise<PartyAddress[]> {
  if (!contactId) return [];

  const { data: party, error: partyError } = await supabase
    .from("contacts")
    .select(`${ADDRESS_COLUMNS}, parent_contact_id`)
    .eq("id", contactId)
    .maybeSingle();

  if (partyError) throw partyError;
  if (!party) return [];

  // If a child address was passed in, resolve against its parent party.
  const rootId = (party as any).parent_contact_id ?? contactId;

  let root: any = party;
  if (rootId !== contactId) {
    const { data, error } = await supabase
      .from("contacts")
      .select(ADDRESS_COLUMNS)
      .eq("id", rootId)
      .maybeSingle();
    if (error) throw error;
    root = data ?? party;
  }

  const { data: children, error: childrenError } = await supabase
    .from("contacts")
    .select(ADDRESS_COLUMNS)
    .eq("parent_contact_id", rootId)
    .order("is_default_shipping", { ascending: false })
    .order("name", { ascending: true });

  if (childrenError) throw childrenError;

  return [
    toPartyAddress(root, true),
    ...(children ?? []).map((row) => toPartyAddress(row, false)),
  ];
}

/**
 * Picks the address a document should default to for a given role.
 *
 * Precedence: explicit default flag → first child with the matching
 * address role → the party's own address. Never returns an address
 * belonging to a different party.
 */
export function pickAddressForRole(
  addresses: PartyAddress[],
  role: "shipping" | "billing",
): PartyAddress | null {
  if (addresses.length === 0) return null;

  const flagged = addresses.find((a) =>
    role === "shipping" ? a.is_default_shipping : a.is_default_billing,
  );
  if (flagged) return flagged;

  const wantedRole: ContactAddressRole =
    role === "shipping" ? "delivery" : "invoice";
  const byRole = addresses.find(
    (a) => a.child_address_type === wantedRole && !isEmptyAddress(a),
  );
  if (byRole) return byRole;

  return addresses.find((a) => a.is_party_itself) ?? null;
}

/** Default ship-to for a party. */
export async function resolveShipTo(
  contactId: string | null | undefined,
): Promise<PartyAddress | null> {
  return pickAddressForRole(await listPartyAddresses(contactId), "shipping");
}

/** Default bill-to for a party. */
export async function resolveBillTo(
  contactId: string | null | undefined,
): Promise<PartyAddress | null> {
  return pickAddressForRole(await listPartyAddresses(contactId), "billing");
}

/** Human label for an address option in a picker. */
export function addressOptionLabel(address: PartyAddress): string {
  if (address.is_party_itself) return `${address.name} (main address)`;
  const roleLabel: Record<ContactAddressRole, string> = {
    delivery: "Delivery",
    invoice: "Invoice",
    contact: "Contact",
    other: "Other",
  };
  const role = address.child_address_type
    ? roleLabel[address.child_address_type]
    : "Address";
  return `${address.name} — ${role}`;
}

/**
 * Captures the bill-to snapshot a financial document must freeze at
 * creation time: the structured link plus the rendered text. Once written
 * the text is historical truth — editing the customer's address book later
 * must never change what an issued document prints.
 *
 * Returns empty fields (not an error) when the party has no usable
 * address, so callers can spread the result unconditionally.
 */
export async function captureBillToSnapshot(
  contactId: string | null | undefined,
): Promise<{ bill_to_contact_id: string | null; billing_address: string | null }> {
  if (!contactId) return { bill_to_contact_id: null, billing_address: null };
  try {
    const address = await resolveBillTo(contactId);
    // No resolvable address means the party is not readable in this
    // business (RLS) or has no address at all. Writing the raw contact id
    // anyway would either link a foreign party — which the
    // `_assert_party_address_contact` trigger rejects — or record a link
    // to an address that was never printed. Store nothing instead.
    if (!address) return { bill_to_contact_id: null, billing_address: null };
    const text = formatAddress(address);
    return {
      bill_to_contact_id: address.id,
      billing_address: text || null,
    };
  } catch {
    // Address capture must never block document creation.
    return { bill_to_contact_id: null, billing_address: null };
  }
}

/**
 * Supplier equivalent of {@link captureBillToSnapshot}: the remit-to address
 * a bill prints. Bills reference the vendor's billing address, so the same
 * "billing" role resolution applies — only the column names differ.
 */
export async function captureRemitToSnapshot(
  contactId: string | null | undefined,
): Promise<{ remit_to_contact_id: string | null; remit_to_address: string | null }> {
  const { bill_to_contact_id, billing_address } =
    await captureBillToSnapshot(contactId);
  return {
    remit_to_contact_id: bill_to_contact_id,
    remit_to_address: billing_address,
  };
}

/**
 * Freezes the bill-to snapshot on a document that was created through an
 * atomic RPC (credit notes, proforma invoices), where the client cannot add
 * columns to the server-side insert.
 *
 * This runs immediately after creation, so the frozen text is still the
 * address as it stood at issue time. It is deliberately best-effort: a
 * failure here must never surface as "document creation failed" when the
 * document exists — the snapshot layer falls back to the live party for
 * rows without a snapshot, which is exactly the legacy behaviour.
 */
export async function freezeBillToSnapshot(
  table: "credit_notes" | "proforma_invoices",
  documentId: string,
  contactId: string | null | undefined,
): Promise<void> {
  if (!documentId || !contactId) return;
  try {
    const snapshot = await captureBillToSnapshot(contactId);
    if (!snapshot.billing_address) return;
    await supabase
      .from(table as any)
      .update(snapshot as any)
      .eq("id", documentId)
      .is("billing_address", null);
  } catch (error) {
    console.warn(`[contactAddresses] bill-to snapshot skipped for ${table}`, error);
  }
}

/**
 * Single-line form of {@link formatAddress}, for inline display in tables,
 * cards and summary rows where a multi-line block would break the layout.
 *
 * Same field order and same omission rules as the block form, so the two
 * can never disagree about what an address contains.
 */
export function formatAddressInline(
  address: Partial<PartyAddress> | null | undefined,
): string {
  return formatAddress(address).split("\n").join(", ");
}
