/**
 * Product physical attributes — client data access only.
 *
 * The browser NEVER computes physical facts here: gross weight derivation,
 * UoM dimension validation, tenant checks and packaging ownership are all
 * enforced by `trg_enforce_physical_attribute_integrity` in the database, and
 * every downstream read goes through `resolve_product_measure`. This module
 * loads and persists rows and nothing else.
 */
import { supabase } from "@/integrations/supabase/client";

/** One measurement level: the base unit (packagingId === null) or a pack. */
export interface PhysicalAttributeRow {
  id: string | null;
  packagingId: string | null;
  netWeight: number | null;
  netWeightUomId: string | null;
  tareWeight: number | null;
  tareWeightUomId: string | null;
  /** Server-derived when net weight is present; read-only in the UI. */
  grossWeight: number | null;
  grossWeightUomId: string | null;
  volume: number | null;
  volumeUomId: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  dimensionUomId: string | null;
}

export function emptyRow(packagingId: string | null): PhysicalAttributeRow {
  return {
    id: null,
    packagingId,
    netWeight: null,
    netWeightUomId: null,
    tareWeight: null,
    tareWeightUomId: null,
    grossWeight: null,
    grossWeightUomId: null,
    volume: null,
    volumeUomId: null,
    length: null,
    width: null,
    height: null,
    dimensionUomId: null,
  };
}

export function isRowEmpty(row: PhysicalAttributeRow): boolean {
  return (
    row.netWeight == null &&
    row.tareWeight == null &&
    row.volume == null &&
    row.length == null &&
    row.width == null &&
    row.height == null
  );
}

export async function loadPhysicalAttributes(
  productId: string,
): Promise<PhysicalAttributeRow[]> {
  const { data, error } = await supabase
    .from("product_physical_attributes")
    .select(
      "id, packaging_id, net_weight, net_weight_uom_id, tare_weight, tare_weight_uom_id, gross_weight, gross_weight_uom_id, volume, volume_uom_id, length, width, height, dimension_uom_id",
    )
    .eq("product_id", productId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    packagingId: r.packaging_id ?? null,
    netWeight: r.net_weight === null ? null : Number(r.net_weight),
    netWeightUomId: r.net_weight_uom_id ?? null,
    tareWeight: r.tare_weight === null ? null : Number(r.tare_weight),
    tareWeightUomId: r.tare_weight_uom_id ?? null,
    grossWeight: r.gross_weight === null ? null : Number(r.gross_weight),
    grossWeightUomId: r.gross_weight_uom_id ?? null,
    volume: r.volume === null ? null : Number(r.volume),
    volumeUomId: r.volume_uom_id ?? null,
    length: r.length === null ? null : Number(r.length),
    width: r.width === null ? null : Number(r.width),
    height: r.height === null ? null : Number(r.height),
    dimensionUomId: r.dimension_uom_id ?? null,
  }));
}

interface PersistArgs {
  organizationId: string;
  businessId: string;
  productId: string;
  rows: PhysicalAttributeRow[];
}

/**
 * Writes the given levels. Rows with no measurements are deleted so a product
 * never carries an empty physical record. Database errors (dimension, tenant,
 * gross-weight mismatch) are surfaced verbatim to the caller.
 */
export async function persistPhysicalAttributes({
  organizationId,
  businessId,
  productId,
  rows,
}: PersistArgs): Promise<void> {
  const toDelete = rows.filter((r) => r.id && isRowEmpty(r)).map((r) => r.id!);
  if (toDelete.length > 0) {
    const { error } = await supabase
      .from("product_physical_attributes")
      .delete()
      .in("id", toDelete);
    if (error) throw new Error(error.message);
  }

  const payload = rows
    .filter((r) => !isRowEmpty(r))
    .map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      organization_id: organizationId,
      business_id: businessId,
      product_id: productId,
      packaging_id: r.packagingId,
      net_weight: r.netWeight,
      net_weight_uom_id: r.netWeightUomId,
      tare_weight: r.tareWeight,
      tare_weight_uom_id: r.tareWeightUomId,
      // gross_weight is derived by the database when net weight is present.
      volume: r.volume,
      volume_uom_id: r.volumeUomId,
      length: r.length,
      width: r.width,
      height: r.height,
      dimension_uom_id: r.dimensionUomId,
    }));

  const inserts = payload.filter((p) => !("id" in p));
  const updates = payload.filter((p) => "id" in p);

  if (inserts.length > 0) {
    const { error } = await supabase
      .from("product_physical_attributes")
      .insert(inserts as never);
    if (error) throw new Error(error.message);
  }
  if (updates.length > 0) {
    const { error } = await supabase
      .from("product_physical_attributes")
      .upsert(updates as never);
    if (error) throw new Error(error.message);
  }
}
