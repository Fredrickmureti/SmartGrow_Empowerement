/**
 * Legacy entry point — kept so existing imports keep working. New code
 * should import from `@/lib/inventory/formatQty`.
 */
export {
  formatQtyAsPacks as formatBaseQtyAsPacks,
  formatQtyWithPacks,
  formatBaseQty,
  decomposeQty,
} from "@/lib/inventory/formatQty";
export type { PackForRollup } from "@/lib/inventory/formatQty";
