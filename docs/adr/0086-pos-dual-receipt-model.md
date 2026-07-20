# ADR 0086 — POS receipt: intentional dual-model (UI vs Print)

Status: Accepted — 2026-07-20  
Supersedes the "collapse `ReceiptDocumentModel` into `DocumentData`" goal in
`.lovable/plan.md` Phase 3 item 7.

## Context

The initial architectural audit called for collapsing `ReceiptDocumentModel`
(client UI model) into `DocumentData` (server canonical print shape) on the
grounds that "one model" is simpler. Deeper review shows the two shapes serve
different consumers with disjoint concerns:

| Concern                              | `ReceiptDocumentModel` (client UI) | `DocumentData` (server print) |
| ------------------------------------ | :--------------------------------: | :---------------------------: |
| Live tender / change derivation      |                 ✓                  |               ✗               |
| `is_reprint` watermark flag          |                 ✓                  |               ✗               |
| `is_offline` (pending-sync) badge    |                 ✓                  |               ✗               |
| Resolved POS title (SALES RECEIPT/…) |                 ✓                  |               ✗               |
| Frozen snapshot re-fetch (tamper)    |                 ✗                  |               ✓               |
| Statements / A4 letterhead docs      |                 ✗                  |               ✓               |
| Kitchen tickets / invoices / POs     |                 ✗                  |               ✓               |
| Signature blocks, HR letters         |                 ✗                  |               ✓               |

Every enterprise POS platform we surveyed maintains the same split:

- **Shopify POS** — `Cart`/`CheckoutViewModel` (UI) vs `Order` (print/API).
- **Square** — `POSTransaction` (UI) vs `Receipt` (print/email).
- **Lightspeed Retail** — `SaleViewModel` vs `SaleDocument`.
- **Odoo POS** — `PosOrder` (UI) vs `AccountMove` (print/accounting).

Collapsing the two would either (a) pollute `DocumentData` with cashier-lifecycle
fields no other renderer needs, or (b) strip UI signals the POS surfaces depend
on. Neither is enterprise-grade.

## Decision

Keep the dual model. Formalize the boundary:

1. **Single source of frozen truth**: `pos_receipt_snapshots.payload`. Both
   `buildReceiptDocument()` (client) and the server's `fetchPOSReceipt()` MUST
   derive from that same row for post-payment receipts. Neither may recompute
   totals from live transactions if a snapshot exists.
2. **`DocumentData` owns every printable / emittable artifact** — thermal PDF,
   ESC/POS bytes, A4 invoice, statement, kitchen ticket, delivery note, HR
   letter, purchase order, quote. No exceptions.
3. **`ReceiptDocumentModel` is UI-only** and only the four surfaces on the
   allowlist may import it: `TransactionSummaryView`, `ReceiptPreviewDialog`,
   `PostPaymentScreen`, `CustomerDisplayRenderer`. Enforced by
   `pos-receipt-model-boundary.test.ts`.
4. **Cross-model consistency contract**: totals derived by the UI model MUST
   equal totals emitted by the print pipeline for the same snapshot. Enforced
   by `pos-receipt-cross-model-consistency.test.ts` (see this ADR's companion
   test).
5. **Reprint path stays server-authoritative**: `ReceiptPreviewDialog` and
   thermal reprint invoke `generate-document` which reads the snapshot; the UI
   model is never marshalled into bytes.

## Consequences

- The `pos-receipt-model-boundary` and cross-model consistency tests are now
  the enforcement mechanism. Any future contributor tempted to feed
  `ReceiptDocumentModel` into an emitter will hit the wall at CI time.
- `.lovable/plan.md` Phase 3 item 7 is retired and replaced with this ADR.
- Future work: if a new emittable artifact (e.g. loyalty card, warranty slip)
  appears, it MUST extend `DocumentData` — not `ReceiptDocumentModel`.

## References

- `src/lib/pos/receipt/ReceiptDocumentModel.ts` (UI shape, docstring)
- `supabase/functions/_shared/templateRenderer.ts` (`DocumentData`)
- `supabase/functions/_shared/receipt/documentToInput.ts` (only adapter)
- `src/test/architecture/pos-receipt-model-boundary.test.ts`
- `src/test/architecture/pos-receipt-cross-model-consistency.test.ts` (new)
- ADR 0084 (canonical Line AST), ADR 0085 (renderer ownership)
