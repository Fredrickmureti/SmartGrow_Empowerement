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
