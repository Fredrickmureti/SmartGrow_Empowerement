/**
 * Party address resolution for document snapshots.
 *
 * A financial document's printed address is a SNAPSHOT: once the document
 * carries its own `billing_address` (or `remit_to_address`) text, that text
 * is the historical truth and must never be replaced by live master data.
 * Only when the column is empty — legacy rows written before the snapshot
 * columns existed — do we fall back to formatting the party's current
 * address, which is the best approximation available.
 *
 * This is the ONE implementation of that rule for the snapshot layer;
 * `src/lib/contactAddresses.ts` owns the equivalent rule for the UI.
 */

export interface SnapshotPartyAddressSource {
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

/** Formats a party's current address into the printed block form. */
export function formatPartyAddress(
  party: SnapshotPartyAddressSource | null | undefined,
): string | null {
  if (!party) return null;
  const cityLine = [party.city, party.state, party.postal_code]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");

  const text = [party.address_line1, party.address_line2, cityLine, party.country]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join("\n");

  return text || null;
}

/**
 * Snapshot first, live party second. Never the other way around.
 */
export function resolveSnapshotAddress(
  storedSnapshot: string | null | undefined,
  party: SnapshotPartyAddressSource | null | undefined,
): string | null {
  const stored = (storedSnapshot ?? "").trim();
  if (stored) return stored;
  return formatPartyAddress(party);
}
