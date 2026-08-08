---
name: Document scanning layer
description: One scanner component/hook/provider across Sales and Purchases; purchasing lines seed at cost price; requisitions excluded
type: feature
---

# Document scanning (Sales + Purchases)

One layer, parameterised — never forked per document:

- `DocumentLineScanner` (`src/components/documents/lines/DocumentLineScanner.tsx`)
  — takes `documentLabel` and `mode` (`capture | verify`). All operator copy
  derives from those props. No screen writes its own scanner strings.
- `useDocumentLineScan` / `usePricedLineScan`
  (`src/features/sales/scan-session/useDocumentLineScan.ts`) — the only
  scan→line applicator.
- `DocumentScanProvider` (`src/contexts/SalesScanContext.tsx`, workspace-neutral
  alias of `SalesScanProvider`) — mounted by `SalesLayout` and `PurchasesLayout`
  with a `workspace` prop.

## Pricing rule

Selling documents seed a scanned line with `scanUnitPrice` (embedded EAN price
> selling price). **Buying documents seed with `scanCostPrice`.** A purchasing
form using `scanUnitPrice` puts a selling price on a purchase order — a real
financial error, guarded by `document-scanner-parity.test.ts`.

## Coverage

Estimate, Proforma, Sales Order, Invoice, Credit Note, Sales Return, Delivery
Note (verify mode), Purchase Order, RFQ, Bill, Purchase Return — create + edit.

**Purchase requisitions are deliberately excluded**: their lines are free-text
demand with no `product_id`, so a resolved scan has nothing to land on. Do not
"complete coverage" by adding a scanner there.

## Guard rule

Architecture guards for this layer must **import** the modules and assert
export names, not grep for JSX strings. The regression that motivated this
(`export function InvoiceLineScanner` in `DocumentLineScanner.tsx`, crashing
eleven routes) passed a text-matching guard.

See ADR 0121.
