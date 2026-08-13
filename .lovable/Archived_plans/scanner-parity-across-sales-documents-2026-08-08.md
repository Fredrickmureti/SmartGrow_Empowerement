# Scanner Parity Across Sales Documents

## Verdict: yes, this is an inconsistency — not a design choice

Scan-to-line entry exists only on invoices. The transport layer that makes it
work is already workspace-wide: `SalesScanProvider` is mounted by
`SalesLayout`, so the paired phone, USB wedge and camera are live on every
Sales page — estimates, sales orders, delivery notes included. The scan chip
even shows "paired" there. What is missing is only the *consumer*: the
`InvoiceLineScanner` toolbar and the two handlers that turn a resolved scan
into a document line. Everything else is shared already (`applyScanToLines`,
`EditableLineItemsGrid`, `PricedLineRow`).

So today the system advertises a capability on eight pages and honours it on
one. That is the defect.

## How enterprise systems treat this

In SAP, Oracle NetSuite, Dynamics 365 and Odoo, barcode entry is a property of
*any* line-item document, not of one document type — the scan resolves an item
and appends or increments a line wherever items are captured. Two behaviours
are universal and worth copying:

- **Priced/ordering documents** (quotation, order, proforma, invoice, credit
  note, return): a scan **adds or finds** a line, priced from the normal price
  source. Free capture, because the operator is composing the document.
- **Fulfilment documents** (delivery note / picking): a scan is
  **verification against the planned lines**, not free capture. Scanning an
  item that isn't on the source order is refused with a clear warning
  ("not on this delivery"), and scanning an item beyond its ordered quantity
  is refused as over-delivery. This is how WMS picking confirmation works
  everywhere, and it is what protects inventory and the customer's order.
  Unsourced (ad-hoc) delivery notes with no source order fall back to free
  capture, since there is nothing to verify against.

Batch capture ("scan a trolley, review quantities, commit") belongs on every
document that supports scanning in these systems, because reviewing before
commit is what makes high-volume scanning safe. So the Scan Session sheet goes
everywhere the toolbar goes.

## What will be built

**1. One generic document line scanner**
Generalise `components/invoices/InvoiceLineScanner.tsx` into
`components/documents/lines/DocumentLineScanner.tsx` — the same component,
with the invoice-specific naming removed and a `mode` of `"capture"` or
`"verify"`. `InvoiceLineScanner` stays as a thin re-export so nothing existing
breaks. Focus rules, F2 handling, pairing button, camera button and the
Scan Session affordance are unchanged.

**2. One shared scan-apply hook**
`useDocumentLineScan` in `src/features/sales/scan-session/` wraps the existing
`applyScanToLines` with the behaviour the invoice pages already implement:
single scan never silently increments (it flashes the matched line), session
commit applies reviewed quantities as-is, trailing empty rows are replaced,
and the affected row flashes. Each document passes only its own line builder
(product id, description, qty field name, price, tax) — no copy-pasted apply
logic.

**3. Wire it into the remaining documents**

| Document | Scan behaviour |
| --- | --- |
| Estimate / Quotation | capture — add or find line, priced |
| Proforma invoice | capture |
| Sales order | capture |
| Credit note | capture |
| Sales return | capture, against the returned-items line row |
| Delivery note (from SO/invoice) | verify — match planned line, block unknown item and over-delivery |
| Delivery note (ad-hoc, no source) | capture |
| Invoice | unchanged |

Each page gets the scanner in the `toolbar` slot of its existing
`EditableLineItemsGrid` and a `linesTableRef`, exactly as the invoice pages do.

**4. Verify mode semantics (delivery notes)**
A scan increments `quantity_delivered` on the matching planned line up to
`quantity_ordered`. Unknown item → toast "not on this delivery note" plus the
existing error scan-feedback sound. At the cap → "already fully delivered".
Lot/serial capture on the line is untouched.

**5. Guardrails**
- Architecture test: every Sales create/edit page that renders
  `EditableLineItemsGrid` with priced or delivery lines must also render
  `DocumentLineScanner`, so a new document type cannot ship without scanning.
- Test that no page re-implements scan-to-line application outside
  `useDocumentLineScan`.
- Unit tests for verify mode: unknown item rejected, over-delivery capped,
  planned line incremented.
- Update `mem/features/sales-rapid-scan.md` with the capture/verify rule.

## Technical notes

- No database or RPC changes; this is form-layer and presentation only.
- No second `useScanTarget` is introduced — every page continues to consume the
  single workspace router target through `useSalesScanController`, per the
  existing rapid-scan architecture.
- `SalesScanChip`'s rapid-mode auto-open-draft currently targets invoice
  drafts from the Invoices list. It stays as-is in this change; per-page
  auto-open for other documents is a separate follow-up.
- Purchases-side documents (POs, goods receipts) are out of scope here; the
  same `DocumentLineScanner` will be reusable for them later.
