/**
 * Sales record shared building blocks — public surface.
 *
 * Every Sales business-record page composes from these + the design
 * system primitives in `@/design-system`. Do not reach into the files
 * directly from a page; import from this barrel so we can evolve the
 * internals without touching pages.
 */
export {
  DocumentTotalsPanel,
  DocumentActivityPanel,
  DocumentAttachmentsPanel,
} from "./panels";
export type {
  DocumentTotalsRow,
  DocumentActivityEntry,
  DocumentAttachment,
} from "./panels";
export { LineItemsGrid } from "./LineItemsGrid";
export type {
  LineItemColumn,
  LineItemRow,
  LineItemRowCell,
} from "./LineItemsGrid";
export { usePeekParam } from "./usePeekParam";
export { SalesRecordScaffold } from "./SalesRecordScaffold";
export { SalesRecordBody } from "./SalesRecordBody";
export { SalesPeekScaffold } from "./SalesPeekScaffold";
export type { DetailField } from "./SalesRecordBody";
export { DocumentPeekShell } from "./DocumentPeekShell";
export { useSalesDocumentRecord } from "./useSalesDocumentRecord";
export { useRecordPrint } from "./useRecordPrint";
export type { RecordPrintKind } from "./useRecordPrint";
