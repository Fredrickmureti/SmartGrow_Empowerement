/**
 * outboundLineTrackingUtils — Phase A.4 persistence helpers.
 *
 * The pickers (`LotPickerPopover`, `SerialPickerPopover`) emit rich
 * payloads, but outbound line tables store a single `lot_number` /
 * `serial_number` string (delivery notes additionally store the full
 * allocation array in `lot_allocations` JSON). These helpers normalize
 * picker output into the shape the DB accepts so every outbound editor
 * persists identically.
 */
import type { LotAllocationPayload } from "./LotPickerPopover";
import type { SerialRow } from "./SerialPickerPopover";

/** Comma-joined `lot_number` for the flat column. Empty → null. */
export function lotNumberFromAllocations(
  allocations: LotAllocationPayload[] | null | undefined,
): string | null {
  if (!allocations || allocations.length === 0) return null;
  const uniq = Array.from(
    new Set(allocations.map((a) => a.lot_number).filter(Boolean)),
  );
  return uniq.length ? uniq.join(", ") : null;
}

/** Full JSON blob for `delivery_note_items.lot_allocations`. */
export function lotAllocationsJson(
  allocations: LotAllocationPayload[] | null | undefined,
): LotAllocationPayload[] | null {
  return allocations && allocations.length ? allocations : null;
}

/** Comma-joined serial numbers for the flat `serial_number` column. */
export function serialNumberFromRows(
  rows: SerialRow[] | null | undefined,
): string | null {
  if (!rows || rows.length === 0) return null;
  const uniq = Array.from(
    new Set(rows.map((r) => r.serial_number).filter(Boolean)),
  );
  return uniq.length ? uniq.join(", ") : null;
}
