---
name: Sales Rapid Scan Mode
description: Workspace-level scan routing for Sales (Invoices) — controller pattern, FIFO buffer, mode toggle. Reuse for Quotes / Sales Orders / Goods Receipt rapid flows.
type: feature
---

`SalesScanProvider` (in `src/contexts/SalesScanContext.tsx`) owns one
`useScanTarget` (priority 5, `allowRepeats: true`) for the entire Sales
workspace. Dialogs register a controller via `useSalesScanController(fn)`;
the Invoices list page registers an open-draft handler via
`useSalesOpenDraftHandler(fn)`. A 5-deep / 500 ms FIFO buffers scans
that arrive during dialog mount.

Mode: `"rapid" | "browse"`, persisted at
`sales.scan.mode:<businessId>:<userId>`. Auto-open-draft only fires in
rapid mode. Mode + pairing status are shown by `<SalesScanChip>`
mounted by `SalesLayout` (bottom-right).

Rules:
- Use `useSalesHasActiveDraft()` (subscribes via `useSyncExternalStore`)
  instead of duplicating "is any dialog open" booleans.
- When `openDraftRef` fires the scan is NOT also enqueued — the dialog
  seeds itself from `initialScan`, so double-apply is impossible.
- `InvoiceLineScanner` refocuses ONLY when `document.activeElement ===
  document.body`. Never query the DOM for the input — use the
  `BarcodeInputFieldHandle` ref.
- F2 is scoped to the closest `[role="dialog"]` ancestor.
- `InvoiceLineRow` is `React.memo`-wrapped; handlers MUST be
  `useCallback`-stable for the memo to engage.

New scan-driven Sales features must reuse this provider — do NOT mount
a second `useScanTarget` at priority 5 inside Sales.

## Scanner parity across Sales documents (enforced)

The Sales workspace scan transport (`SalesScanProvider`) is workspace-wide, so
EVERY line-capturing Sales document consumes it — not just invoices:

- One component: `src/components/documents/lines/DocumentLineScanner.tsx`
  (`InvoiceLineScanner` is gone). Modes: `capture` (authoring) and `verify`
  (fulfilment).
- One apply hook: `src/features/sales/scan-session/useDocumentLineScan.ts`
  (`usePricedLineScan` for priced lines). Never re-implement the scan→line merge.
- Wired: Estimate (create/edit), Proforma, Sales Order (create/edit), Invoice
  (create/edit), Credit Note (create/edit), Sales Return, Delivery Note.
- `doc_author` rule kept: a repeat single scan flashes the existing line instead
  of silently bumping quantity. Reviewed Scan Session batches are authoritative.
- Delivery notes are the exception: they count physical units, so repeat scans
  increment delivered quantity and over-delivery beyond `quantity_ordered` is
  REFUSED with a toast, never clamped silently.
- Guard: `src/test/architecture/sales-document-scanner-parity.test.ts`.
