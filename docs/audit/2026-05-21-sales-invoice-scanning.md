# Sales / Invoice scanning — audit + delivery

Date: 2026-05-21

## Findings

- Scanner kernel + resolver already universal; path prefix `pos/` only.
- Three Inventory consumers fired scans via `BarcodeInputField.onChange`
  + `length >= 4` heuristic. Spurious on paste / search typing.
- Merge-or-append line logic duplicated across POSTerminal, PhysicalCount,
  Transfers, GoodsReceiptDialog.
- Invoices: zero scanner integration.

## Shipped

| # | Change | File |
|---|---|---|
| 1 | Canonical re-export barrels | `src/services/scanner/index.ts`, `src/hooks/scanner/index.ts` |
| 2 | Shared `applyScanToLines` + tests | `src/services/scanner/applyScanToLines.ts`, `src/test/scanner/apply-scan-to-lines.test.ts` |
| 3 | `onScan` prop on `BarcodeInputField` | `src/components/scanner/BarcodeInputField.tsx` |
| 4 | Killed `length>=4` heuristic | `PhysicalCount.tsx`, `Transfers.tsx`, `GoodsReceiptDialog.tsx` |
| 5 | `<InvoiceLineScanner>` (scan-first, F2, pairing, row flash) | `src/components/invoices/InvoiceLineScanner.tsx` |
| 6 | Scanner wired into Create + Edit invoice dialogs | `CreateInvoiceDialog.tsx`, `EditInvoiceDialog.tsx` |
| 7 | ADR-0017 | `docs/adr/0017-universal-product-acquisition-infrastructure.md` |

## Verification

- Phase A helper covered by unit tests (`apply-scan-to-lines.test.ts`).
- POS terminal cart consumer untouched — `scanBus.on` + `wasConsumed`
  guard preserved.
- Phone pairing button reused (single workspace session) so a paired
  phone now also drives invoice line entry on focus.
- F2 refocus + auto-refocus skip when the active element lives inside
  the lines table — prevents stealing focus during qty edits.

## Deferred

- Rename `pos_resolve_barcode` RPC to `resolve_barcode`.
- Architecture guard test for "no consumer reads scans from
  `BarcodeInputField.onChange` by string length" — sound, but author it
  with the next wave to avoid flake.

## Wave 3 close-out — 2026-06-07

Independent re-audit of the Wave 2 implementation (every claim was
traced against the actual code, none taken on trust):

| Claim | Verdict | Evidence |
|---|---|---|
| `SalesScanContext` with `mode: rapid \| browse`, persisted per `business:user` | Verified | `src/contexts/SalesScanContext.tsx` |
| `useSyncExternalStore`-based `useSalesHasActiveDraft()` | Verified | listener set + `notifyActiveDraft` fired on register/unregister |
| Auto-open-draft gated to rapid mode; no double-apply | Verified | early return after `open(resolved)`; queue push only on fallthrough |
| `SalesScanChip` rendered bottom-right by `SalesLayout` | Verified | mode toggle + pairing chip + one-time hint |
| `Invoices.tsx` uses `useSalesHasActiveDraft()` | Verified | replaces the local `!showCreateDialog && !showEditDialog && …` boolean |
| `InvoiceLineScanner` — ref-based focus, body-only refocus, scoped F2 | Verified | no `document.querySelector`; F2 listener attached to closest `[role="dialog"]` |
| `InvoiceLineRow` memoized, handlers `useCallback`-stable in both dialogs | Verified | `updateLineItem` / `removeLineItem` / `handleProductSelect` are `useCallback` in Create + Edit |
| Architecture guard `invoice-scanner-no-domquery.test.ts` | Verified | strips comments before scanning |
| ADR-0018 + memory entry + index | Verified | present |

### Tests added this wave

- `src/test/sales/sales-scan-context.test.tsx` — 5 cases: late-mount
  queue replay, controller-wins-over-open-draft, rapid-vs-browse gate,
  no double-apply on open-draft path, persistence per `business:user`
  with no leak across logins.
- `src/test/sales/invoice-line-row-memo.test.tsx` — 2 cases: unrelated
  parent state change does NOT re-render rows; updating one item
  re-renders only that row.

Suite: 7/7 green.

### Accepted — out of scope for rapid scan

The mobile-card line entry in `CreateInvoiceDialog` and `EditInvoiceDialog`
still uses inline arrow handlers (`(e) => updateLineItem(...)`) and is
NOT memoized. This is intentional and not a regression: mobile cards are
not the rapid-scan target surface — warehouse / retail operators run on
desktop and Electron. The memo contract on `InvoiceLineRow` (desktop)
is what keeps >60 scans/min smooth.

No deferred work remains for the Sales-invoice scanning lane.