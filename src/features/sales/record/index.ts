/**
 * Sales-specific record helpers.
 *
 * The document-workspace primitives (scaffolds, peek shell, line grid,
 * panels, record hooks) are NOT here — they live in `@/design-system/records`
 * and are shared by Sales, Purchases, Finance, Inventory and Warehouse.
 * Only genuinely Sales-coupled helpers belong in this module.
 */
export { useRecordPrint } from "./useRecordPrint";
export type { RecordPrintKind } from "./useRecordPrint";
