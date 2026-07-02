/**
 * Design System — Records surface.
 *
 * Cross-application public entry point for the record-interaction
 * scaffolds (peek sheet, object page, document body, line-items grid,
 * document panels, peek param hook, document-record hook).
 *
 * These primitives were originally extracted while migrating Sales
 * and still physically live under `src/features/sales/record/`. This
 * barrel promotes them into the design system with generic names so
 * Purchases / Inventory / Finance code depends on `@/design-system`
 * only, never on a sibling feature module.
 *
 * The `Sales*` prefixed names are kept as aliases for the Sales code
 * that already imports them, so no page has to move in the same pass.
 * New code SHOULD import the generic names (`RecordScaffold`,
 * `RecordBody`, `PeekScaffold`, `useDocumentRecord`).
 */

export {
  SalesRecordScaffold as RecordScaffold,
  SalesRecordScaffold,
} from "@/features/sales/record/SalesRecordScaffold";
export {
  SalesRecordBody as RecordBody,
  SalesRecordBody,
} from "@/features/sales/record/SalesRecordBody";
export type { DetailField } from "@/features/sales/record/SalesRecordBody";
export {
  SalesPeekScaffold as PeekScaffold,
  SalesPeekScaffold,
} from "@/features/sales/record/SalesPeekScaffold";
export { DocumentPeekShell } from "@/features/sales/record/DocumentPeekShell";
export { LineItemsGrid } from "@/features/sales/record/LineItemsGrid";
export type {
  LineItemColumn,
  LineItemRow,
  LineItemRowCell,
} from "@/features/sales/record/LineItemsGrid";
export {
  DocumentTotalsPanel,
  DocumentActivityPanel,
  DocumentAttachmentsPanel,
} from "@/features/sales/record/panels";
export type {
  DocumentTotalsRow,
  DocumentActivityEntry,
  DocumentAttachment,
} from "@/features/sales/record/panels";
export { usePeekParam } from "@/features/sales/record/usePeekParam";
export {
  useSalesDocumentRecord as useDocumentRecord,
  useSalesDocumentRecord,
} from "@/features/sales/record/useSalesDocumentRecord";
