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
export { RecordScaffold } from "./RecordScaffold";
export { RecordBody } from "./RecordBody";
export { PeekScaffold } from "./PeekScaffold";
export type { DetailField } from "./RecordBody";
export { DocumentPeekShell } from "./DocumentPeekShell";
export { useDocumentRecord } from "./useDocumentRecord";
export { useRecordPrint } from "./useRecordPrint";
export type { RecordPrintKind } from "./useRecordPrint";
