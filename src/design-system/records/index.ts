/**
 * Design System — Document Workspace.
 *
 * The canonical, domain-agnostic record-interaction layer. Every
 * transactional module (Sales, Purchases, Finance, Inventory, Warehouse,
 * Payroll) composes its list → peek → object-page experience from these
 * primitives. There is exactly one implementation of each concern:
 *
 *   DocumentWorkspace   one renderer, two presentations (page | peek)
 *   RecordScaffold      full-page projection of a DocumentRecordView
 *   PeekScaffold        drawer projection of the same descriptor
 *   RecordBody          the shared section stack both projections use
 *   LineItemsGrid       the only line-item renderer (container-adaptive)
 *   panels              totals / activity / attachments right-rail blocks
 *   documentStatus      the single status label + tone vocabulary
 *   DocumentLifecycleStrip  the order-to-cash / procure-to-pay traversal
 *
 * Do not fork any of these inside a feature module.
 */

export { RecordScaffold } from "./RecordScaffold";
export type { DetailField } from "./RecordBody";
export { RecordBody } from "./RecordBody";
export { PeekScaffold } from "./PeekScaffold";
export { DocumentPeekShell } from "./DocumentPeekShell";
export { LineItemsGrid } from "./LineItemsGrid";
export type {
  LineItemColumn,
  LineItemRow,
  LineItemRowCell,
} from "./LineItemsGrid";
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
export { usePeekParam } from "./usePeekParam";
export { useDocumentRecord } from "./useDocumentRecord";
export { useDocumentActivity } from "./useDocumentActivity";

// Status vocabulary — one registry for every document type.
export {
  DocumentStatusBadge,
  documentStatusMeta,
  documentStatusLabel,
  documentStatusTone,
} from "./documentStatus";
export type { DocumentStatusTone, DocumentKind } from "./documentStatus";

// Money summary derivation — one implementation.
export { buildTotalsRows, deriveMoney } from "./money";
export type { DocumentMoney } from "./money";

// Lifecycle traversal.
export { DocumentLifecycleStrip } from "./DocumentLifecycleStrip";
export type { LifecycleDocType } from "./DocumentLifecycleStrip";

// The canonical document descriptor + the shared renderer both projections use.
export type { DocumentRecordView } from "./types";
export {
  DocumentWorkspaceBody,
  DocumentWorkspaceAside,
  DocumentStatusSlot,
  resolveTotalsRows,
} from "./DocumentWorkspace";
