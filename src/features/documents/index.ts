/**
 * Document primitives — the shared, business-domain-agnostic building
 * blocks every substantial business record (Sales / Purchases / Inventory /
 * Finance) composes from. These are physical re-exports of the pieces
 * originally hoisted for Sales in `src/features/sales/record/` that
 * carry zero Sales-specific coupling.
 *
 * Rules:
 *   - Sales code keeps importing from `@/features/sales/record` (unchanged).
 *   - Every other app imports from `@/features/documents`.
 *   - Anything Sales-specific (routing helpers, Sales scaffolds) stays in
 *     `src/features/sales/record/` and is NOT re-exported here.
 *
 * Why the barrel instead of moving files: 30+ Sales importers already
 * reach into `@/features/sales/record`. Moving the files would either
 * break those imports or leave shim files behind. A single re-export
 * barrel gives Purchases / Inventory / Finance a domain-neutral import
 * surface without disturbing Sales, and lets the modules physically
 * migrate later if we ever want to sunset `@/features/sales/record`.
 */

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

export { LineItemsGrid } from "@/features/sales/record/LineItemsGrid";
export type {
  LineItemColumn,
  LineItemRow,
  LineItemRowCell,
} from "@/features/sales/record/LineItemsGrid";

export { DocumentPeekShell } from "@/features/sales/record/DocumentPeekShell";
export { usePeekParam } from "@/features/sales/record/usePeekParam";

// Generic single-record fetcher. Named `useSalesDocumentRecord` for
// historical reasons — re-exported under the neutral name so non-Sales
// callers don't advertise a lie in their import.
export { useSalesDocumentRecord as useDocumentRecord } from "@/features/sales/record/useSalesDocumentRecord";