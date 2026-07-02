# ADR 0018 — Rapid Invoice Scan Mode (context-aware Sales scanning)

Status: Accepted (2026-06-06)

## Context

Invoice barcode scanning shipped as an input-focused workflow: every
scan went through `<BarcodeInputField>` and required the field to be
focused. Operators in retail / wholesale / pharmacy hit constant focus
loss (Radix Select portals, table-cell edits, dialog mounts), and any
scan that arrived during the 100-300 ms Create-dialog mount window was
dropped. The auto-create-draft path also fired indiscriminately, so any
keyboard wedge scan on the Sales list page would open a new invoice
even when the operator was browsing.

## Decision

Promote scan capture to the **Sales workspace** and add an explicit
operational mode.

1. `SalesScanProvider` (mounted by `SalesLayout`) owns ONE long-lived
   `useScanTarget` registration at priority 5 with `allowRepeats: true`.
   Resolved scans land on a `controllerRef` set by the topmost open
   invoice dialog; if no controller is registered the scan is handed to
   an `openDraftRef` (the Invoices list page) — but **only when
   `mode === "rapid"`**. Browse mode (the default) ignores scans on the
   list page so the operator's intent stays predictable.
2. A 5-deep / 500 ms FIFO buffers scans that arrive in the dialog-mount
   blind spot and replays them on the next animation frame after the
   controller registers.
3. `useSalesHasActiveDraft()` exposes the controller state via
   `useSyncExternalStore`. The list page subscribes through this hook
   instead of duplicating "is any dialog open" booleans, eliminating
   drift when new dialogs are added.
4. The auto-open path is exclusive: when `openDraftRef` fires the scan
   is NOT also enqueued — the dialog seeds itself from `initialScan` so
   double-apply is impossible.
5. Mode is persisted in `localStorage` keyed by
   `sales.scan.mode:<businessId>:<userId>` so each operator's preference
   survives reload but does not leak across logins.
6. `SalesScanChip` (bottom-right of the Sales layout) shows the current
   mode, the paired-phone status, a pairing CTA, and a one-click
   toggle — operators always see whether the workspace is armed.

## Focus management

- `InvoiceLineScanner` keeps a `BarcodeInputFieldHandle` ref; refocus
  only fires when `document.activeElement === document.body` AND the
  active element is not inside the `linesTableRef` — Radix portals and
  in-cell editing are never interrupted.
- F2 is scoped to the `[role="dialog"]` ancestor, so a stacked dialog
  (e.g. Record Payment opened over a Create Invoice) does not steal F2
  back to the hidden scanner.
- The scan hot path no longer requires the input to be focused. The
  visible field is now a manual-entry surface; the real transport is
  the router target inside the provider.

## Performance

- `<InvoiceLineRow>` (used by Create and Edit dialogs' desktop tables)
  is `React.memo`-wrapped. With `useCallback` handlers
  (`updateLineItem`, `removeLineItem`, `handleProductSelect`) only the
  row whose item identity changed re-renders per scan, instead of the
  full dialog form.

## Consequences

- New scan-driven Sales features (Quotes, Sales Orders, Goods Receipt
  rapid mode) reuse the controller pattern by registering through
  `useSalesScanController`. No new transports, RPCs, or dedupe logic.
- A workspace without `SalesScanProvider` falls back to the standard
  per-field `<BarcodeInputField>` flow — the hooks are no-ops outside
  the provider.

## Out of scope

- Cross-module Rapid Mode for Goods Receipt / Stock Transfer — same
  shape will apply, ship after Sales is stable.
- Renaming `pos_resolve_barcode` SQL RPC (alias works).
- Native Electron global-shortcut scan capture while the app is
  unfocused.
