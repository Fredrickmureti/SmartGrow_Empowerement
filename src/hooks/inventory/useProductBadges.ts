/**
 * useProductBadges — single source of truth for the small chips shown on
 * product list rows and the detail panel header (Multi-UoM, Lot, Expiry,
 * Service, Non-inventory). Centralised so future tracking modes (variants,
 * serials) only have to change one file.
 */

export type ProductBadge =
  | "multi-uom"
  | "lot"
  | "expiry"
  | "service"
  | "non-inventory";

interface ProductLike {
  type?: string | null;
  track_inventory?: boolean | null;
  is_lot_tracked?: boolean | null;
  is_expiry_tracked?: boolean | null;
}

export function getProductBadges(
  product: ProductLike | null | undefined,
  hasPackaging: boolean,
): ProductBadge[] {
  if (!product) return [];
  const badges: ProductBadge[] = [];
  if (product.type && product.type !== "product") badges.push("service");
  else if (product.track_inventory === false) badges.push("non-inventory");
  if (hasPackaging) badges.push("multi-uom");
  if (product.is_lot_tracked) badges.push("lot");
  if (product.is_expiry_tracked) badges.push("expiry");
  return badges;
}

export const PRODUCT_BADGE_META: Record<
  ProductBadge,
  { label: string; tone: "default" | "secondary" | "outline"; title: string }
> = {
  "multi-uom": {
    label: "Multi-UoM",
    tone: "outline",
    title: "Sold or purchased in multiple units (cartons, packs, …).",
  },
  lot: {
    label: "Lot",
    tone: "outline",
    title: "Each receipt records a lot number; FEFO allocation on sale.",
  },
  expiry: {
    label: "Expiry",
    tone: "outline",
    title: "Lots carry an expiry date — FEFO allocator gives priority.",
  },
  service: {
    label: "Service",
    tone: "secondary",
    title: "Non-stock service item — inventory metrics do not apply.",
  },
  "non-inventory": {
    label: "Non-stock",
    tone: "secondary",
    title: "Inventory tracking is off for this product.",
  },
};
