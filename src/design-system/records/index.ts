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
  RecordScaffold as RecordScaffold,
  RecordScaffold,
} from "@/features/sales/record/RecordScaffold";
export {
  RecordBody as RecordBody,
  RecordBody,
} from "@/features/sales/record/RecordBody";
export type { DetailField } from "@/features/sales/record/RecordBody";
export {
  PeekScaffold as PeekScaffold,
  PeekScaffold,
} from "@/features/sales/record/PeekScaffold";
export { DocumentPeekShell } from "@/design-system/records/DocumentPeekShell";
export { LineItemsGrid } from "@/design-system/records/LineItemsGrid";
export type {
  LineItemColumn,
  LineItemRow,
  LineItemRowCell,
} from "@/design-system/records/LineItemsGrid";
export {
  DocumentTotalsPanel,
  DocumentActivityPanel,
  DocumentAttachmentsPanel,
} from "@/design-system/records/panels";
export type {
  DocumentTotalsRow,
  DocumentActivityEntry,
  DocumentAttachment,
} from "@/design-system/records/panels";
export { usePeekParam } from "@/design-system/records/usePeekParam";
export {
  useDocumentRecord as useDocumentRecord,
  useDocumentRecord,
} from "@/features/sales/record/useDocumentRecord";
