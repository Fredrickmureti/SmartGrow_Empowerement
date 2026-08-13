/**
 * Product lifecycle seam.
 *
 * `products.status` is the authoritative lifecycle state; the legacy
 * `is_active` boolean is DERIVED from it by a database trigger, so nothing in
 * the app may treat `is_active` as the source of truth.
 *
 * Transitions are enforced in the database (`trg_enforce_product_lifecycle`):
 * nothing returns to `draft`, archiving a product that still holds stock is
 * refused, and archived products cannot receive stock movements at all.
 * This module is the only client-side write path for a lifecycle change.
 */
import { supabase } from "@/integrations/supabase/client";

export const PRODUCT_LIFECYCLE_STATUSES = [
  "draft",
  "active",
  "discontinued",
  "archived",
] as const;

export type ProductLifecycleStatus = (typeof PRODUCT_LIFECYCLE_STATUSES)[number];

const LABELS: Record<ProductLifecycleStatus, string> = {
  draft: "Draft",
  active: "Active",
  discontinued: "Discontinued",
  archived: "Archived",
};

export function productLifecycleLabel(status?: string | null): string {
  return LABELS[(status ?? "active") as ProductLifecycleStatus] ?? "Active";
}

/** Can this product be sold, purchased or received? */
export function isProductTransactable(status?: string | null): boolean {
  return (status ?? "active") === "active";
}

/** States an operator may move to from the current one (mirrors the DB matrix). */
export function allowedProductTransitions(
  status?: string | null,
): ProductLifecycleStatus[] {
  switch ((status ?? "active") as ProductLifecycleStatus) {
    case "draft":
      return ["active", "archived"];
    case "active":
      return ["discontinued", "archived"];
    case "discontinued":
      return ["active", "archived"];
    case "archived":
      return ["active", "discontinued"];
    default:
      return [];
  }
}

export function describeLifecycleFailure(message: string): string {
  if (message.includes("PRODUCT_ARCHIVE_HAS_STOCK")) {
    return "This product still holds stock. Move or write it off before archiving.";
  }
  if (message.includes("PRODUCT_LIFECYCLE_TRANSITION")) {
    return "That status change is not allowed for this product.";
  }
  if (message.includes("PRODUCT_LIFECYCLE_STATUS_INVALID")) {
    return "That is not a valid product status.";
  }
  if (message.includes("PRODUCT_NOT_FOUND")) {
    return "This product no longer exists. Reload the list and try again.";
  }
  if (message.includes("Not a member of organization") || message.includes("Not authenticated")) {
    return "You do not have access to this business.";
  }
  return "The product status could not be changed.";
}

export async function setProductLifecycleStatus(
  productId: string,
  status: ProductLifecycleStatus,
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_product_lifecycle_status" as never, {
    p_product_id: productId,
    p_status: status,
    p_reason: reason ?? null,
  } as never);

  if (error) {
    throw new Error(describeLifecycleFailure(String(error.message ?? error)));
  }
}
