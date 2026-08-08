# ADR 0121 — Document scanning: one layer for Sales and Purchases

Status: Accepted (2026-08-08)

> Extends [ADR 0018](./0018-rapid-invoice-scan-mode.md) from the Sales
> workspace to every transactional document workspace. The transport ladder
> (`scanBus` → `scanRouter` → `useResolveBarcode`) established by
> [ADR 0017](./0017-universal-product-acquisition-infrastructure.md) is
> unchanged and still authoritative.

## Context

An audit of the transactional document flows found three problems.

1. **A load-time crash.** `src/components/documents/lines/DocumentLineScanner.tsx`
   still declared `export function InvoiceLineScanner`, while all eleven
   Sales pages imported `DocumentLineScanner`. Every one of those routes
   failed to load. The existing guard only grepped for the string
   `<DocumentLineScanner`, which the broken files still contained, so the
   guard passed while the workspace was down.
2. **Sales-shaped generic code.** The component was generic in name only:
   its copy said "Invoice", and the provider that owns the scan target was
   `SalesScanProvider`, keyed to the Sales workspace.
3. **Purchases had no scanning at all.** Purchase orders, RFQs, bills and
   purchase returns author product lines exactly like their selling
   counterparts, and received a barcode from the same physical devices, but
   no purchasing form consumed the transport.

## Decision

**One component, one hook, one provider — parameterised, not forked.**

- `DocumentLineScanner` takes `documentLabel` and `mode`
  (`capture | verify`). All operator copy derives from those; no screen
  writes its own scanner strings.
- `DocumentScanProvider` (the workspace-neutral name for the provider
  formerly known only as `SalesScanProvider`) takes a `workspace` prop and
  is mounted by both `SalesLayout` and `PurchasesLayout`.
- `useDocumentLineScan` remains the only scan→line applicator, with
  `usePricedLineScan` as the pre-wired priced-line case.

**Buying documents price at cost.** `scanCostPrice` is the purchasing
counterpart of `scanUnitPrice`. A scanned line on a PO or bill seeds from
the product's cost price; vendor price lists still override afterwards
through the host form's own pricing logic. A purchasing form that reaches
for `scanUnitPrice` is a guard failure — a selling price on a purchase
order is a real financial error, not a cosmetic one.

**Guards import, they do not grep.** `document-scanner-parity.test.ts`
imports the scanner module, the hook module and the context module and
asserts the export names exist. Text matching cannot see an export-name
mismatch; that is exactly the regression that motivated the guard.

## Coverage

Scanning is mounted on: Estimate, Proforma, Sales Order, Invoice, Credit
Note, Sales Return, Delivery Note (verify mode), Purchase Order, RFQ, Bill
and Purchase Return — create and edit forms alike.

## Out of scope

- **Purchase requisitions.** Their lines are free-text statements of demand
  with no `product_id` column, so a resolved scan has nothing to land on.
  Adding a scanner there would decode a barcode into a field that cannot
  hold it. Revisit only if requisition lines gain a catalogue reference.
- Renaming the `pos_resolve_barcode` RPC (functionally universal).
- Goods Receipt / Stock Transfer rapid mode — warehouse surfaces follow
  [ADR 0120](./0120-warehouse-scanning-one-engine-entity-intents-handheld-first.md).
