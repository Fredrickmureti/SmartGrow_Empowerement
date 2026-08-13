/**
 * Product save seam — one transaction, one round trip.
 *
 * Before this seam a product save was four independent network writes (master,
 * identifiers, packaging, physical attributes). Any failure after the first
 * left a half-built product behind ("product created — packaging save failed"),
 * which operators experienced as an edit that "did not stick".
 *
 * `save_product_atomic` performs the whole save inside a single database
 * transaction: nothing is written unless everything is written. It also
 * delegates identifier writes to `upsert_product_identifier` /
 * `retire_product_identifier`, so the identity invariants (lifecycle,
 * primary-code, supplier scope) keep living in exactly one place.
 *
 * New packaging levels can be referenced by measurement and identifier rows in
 * the SAME payload via `client_key` / `packaging_client_key`, so a pack and its
 * barcode and its weight can be created together.
 *
 * Opening stock is deliberately NOT part of this call — it stays on
 * `create_product_with_opening_stock_atomic` because it posts to the ledger.
 */
import { supabase } from "@/integrations/supabase/client";

export interface PackagingInput {
  /** Existing packaging row id; omit to insert. */
  id?: string | null;
  /** Local handle so child rows in this payload can point at a new level. */
  client_key?: string;
  name: string;
  qty_in_base_uom: number;
  is_purchase_default?: boolean;
  is_sales_default?: boolean;
  /** Persisted parent, or use `parent_client_key` for a level created here. */
  parent_packaging_id?: string | null;
  parent_client_key?: string;
  qty_in_parent?: number | null;
  is_shipping_unit?: boolean;
}

export interface PhysicalInput {
  id?: string | null;
  packaging_id?: string | null;
  packaging_client_key?: string;
  net_weight?: number | null;
  net_weight_uom_id?: string | null;
  tare_weight?: number | null;
  tare_weight_uom_id?: string | null;
  volume?: number | null;
  volume_uom_id?: string | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimension_uom_id?: string | null;
  /** Remove this measurement level. */
  _delete?: boolean;
}

export interface IdentifierInput {
  id?: string | null;
  code?: string;
  kind?: string;
  is_primary?: boolean;
  packaging_id?: string | null;
  packaging_client_key?: string;
  supplier_id?: string | null;
  /** Archive (never hard-delete) this identifier. */
  _retire?: boolean;
}

export interface SaveProductInput {
  /** Product master columns. Unknown keys are ignored by the database. */
  product: Record<string, unknown>;
  /** Omit to create, pass to update. */
  productId?: string | null;
  packaging?: PackagingInput[];
  physical?: PhysicalInput[];
  identifiers?: IdentifierInput[];
  /**
   * Per-jurisdiction fiscal metadata (KRA eTIMS today). It lives in
   * `product_tax_localization`, never on the product master, so the core
   * product stops carrying one country's tax vocabulary.
   */
  localization?: LocalizationInput | null;
}

export interface LocalizationInput {
  /** Defaults to `origin_country`, then 'KE'. */
  jurisdiction?: string;
  classification_code?: string | null;
  item_code?: string | null;
  unit_code?: string | null;
  packaging_unit?: string | null;
  origin_country?: string | null;
  registration_status?: string | null;
  registered_at?: string | null;
}

export interface SaveProductResult {
  productId: string;
  /** client_key -> persisted packaging id, for follow-up UI state. */
  packagingKeys: Record<string, string>;
}

/** Maps raw database errors to wording an operator can act on. */
export function describeProductSaveFailure(message: string): string {
  if (message.includes("PACKAGING_CYCLE")) {
    return "That packaging level would contain itself. Pick a different parent pack.";
  }
  if (message.includes("PACKAGING_DEPTH")) {
    return "Packaging can be nested up to 8 levels deep.";
  }
  if (message.includes("PACKAGING_INCONSISTENT")) {
    return "The pack quantities contradict each other — a pack must equal its parent pack multiplied by how many it holds.";
  }
  if (message.includes("PACKAGING_SCOPE")) {
    return "That packaging level belongs to another product.";
  }
  if (message.includes("PACKAGING_INVALID")) {
    return "Each pack needs a name and a quantity greater than zero.";
  }
  if (message.includes("PRODUCT_NOT_FOUND")) {
    return "This product no longer exists. Reload the list and try again.";
  }
  if (message.includes("PRODUCT_PAYLOAD_INVALID")) {
    return "The product could not be saved because required details are missing.";
  }
  if (message.includes("PHYSICAL_") || message.includes("MEASURE_")) {
    return "The measurements could not be saved — check the units you selected.";
  }
  if (message.includes("PRODUCT_LOCALIZATION_INVALID")) {
    return "The tax details could not be saved — check the classification, unit and packaging codes.";
  }
  if (message.includes("PRODUCT_LIFECYCLE_TRANSITION")) {
    return "That status change is not allowed for this product.";
  }
  if (message.includes("PRODUCT_ARCHIVE_HAS_STOCK")) {
    return "This product still holds stock. Move or write it off before archiving.";
  }
  if (message.includes("Not a member of organization") || message.includes("Not authenticated")) {
    return "You do not have access to this business.";
  }
  return "The product could not be saved. Nothing was changed.";
}

export async function saveProductAtomic(input: SaveProductInput): Promise<SaveProductResult> {
  const { data, error } = await supabase.rpc("save_product_atomic" as never, {
    p_product: input.product,
    p_product_id: input.productId ?? null,
    p_packaging: input.packaging ?? [],
    p_physical: input.physical ?? [],
    p_identifiers: input.identifiers ?? [],
    p_localization: input.localization ?? null,
  } as never);

  if (error) {
    throw new Error(describeProductSaveFailure(String(error.message ?? error)));
  }

  const result = data as { success?: boolean; product_id?: string; packaging_keys?: Record<string, string> } | null;
  if (!result?.success || !result.product_id) {
    throw new Error("The product could not be saved. Nothing was changed.");
  }

  return {
    productId: result.product_id,
    packagingKeys: result.packaging_keys ?? {},
  };
}
