/**
 * Universal scanner kernel — canonical barrel.
 *
 * The kernel originally lived under `src/services/pos/*` (history). It is
 * NOT POS-specific: any module (Sales, Inventory, Purchases, HR — anything
 * that needs to acquire a product/identity from a barcode) imports from
 * here. New code should use `@/services/scanner/*` and `@/hooks/scanner/*`.
 *
 * The `@/services/pos/*` paths still resolve to the same modules; they are
 * preserved for back-compat and the POS terminal's ambient cart consumer.
 */

export { scanBus } from "@/services/pos/scanBus";
export type { ScanEvent, ScanProgress } from "@/services/pos/scanBus";
export { scanRouter } from "@/services/pos/scanRouter";
export type { ScanTargetEntry, ScanWorkflow } from "@/services/pos/scanRouter";
export { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";
export type { ScanFeedback } from "@/services/pos/scanFeedbackBus";
export { parseScanPayload } from "@/services/pos/parseBarcode";
export type { ParsedScan } from "@/services/pos/parseBarcode";

export {
  applyScanToLines,
  type ApplyScanResult,
  type ApplyScanInput,
} from "./applyScanToLines";