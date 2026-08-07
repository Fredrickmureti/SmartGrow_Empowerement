# Sales Payment Receipt — thermal rendering rework + output policy catalogue

## What a "payment receipt" actually is (and why it can't behave like a POS receipt)

A POS receipt is a **sale document**: it proves goods changed hands. Its body is a product grid; its arithmetic is subtotal → discount → tax → total → tender → change; its fiscal duty (eTIMS/KRA, TRA, SAT) is to report a taxable supply.

A sales payment receipt (NetSuite "Customer Payment", Odoo "Payment Receipt", SAP "Incoming Payment / official receipt", Oracle "Receipt") is a **cash-application document**. It proves money was received and shows where the money was applied. Its body is an allocation ledger, not a product grid:

```text
RECEIVED FROM   <customer>
Payment method  M-Pesa · ref QDR7X1
Applied to
  Doc            Doc date    Applied      Balance
  INV-000148     04/08/26   12,000.00     3,000.00
  INV-000151     06/08/26    8,000.00         0.00
  Total applied             20,000.00
  On account (unapplied)     5,000.00
  AMOUNT RECEIVED           25,000.00
Customer balance after                    3,000.00
```

Things a payment receipt has that a POS receipt does not: applied-document table, balance after per document, unapplied/on-account amount, customer AR balance after, instrument reference (cheque no / M-Pesa code / bank ref), "received by" + signature line, and (in many jurisdictions) amount in words. Things it must NOT have: quantities, unit prices, a product grid, or a VAT breakdown — the tax was declared on the invoice; restating it on the receipt double-states the supply. (Exception: cash-basis fiscal regimes, which is why the fiscal block stays available but off by default.)

## Verdicts — what is actually wrong in this codebase

Confirmed by reading the pipeline and querying the database:

1. **The snapshot fakes a product grid.** `salesPaymentReceipt.ts:156-189` builds synthetic `items[]` (`Invoice X`, qty 1, unit price = applied amount) *in addition to* `payment_allocations`. Downstream the thermal engine prints the allocation table and then prints `Subtotal / TOTAL` derived from those fake items — the same money stated twice under two headings.
2. **The tender is never printed.** The snapshot stores `payment_method` / `payment_reference` as scalars, but `documentToInput.ts:179` only reads `doc.pos_payments[]`, and `defaultBusinessDocSettings` sets `show_payment_method:false` for every non-POS document. So a *payment* receipt prints without the method or the M-Pesa/cheque reference — the one field a customer checks.
3. **No branding, because the snapshot carries no receipt settings.** POS snapshots carry `pos_receipt_settings` (company ← register merge: logo, header, footer, cut mode, copies, font, return policy). The payment-receipt snapshot carries none, so `documentToInput.ts:67-99` falls back to a hardcoded default map. That is the main reason the sales receipt "looks weird" next to the POS one: no logo, no header/footer, engine-default density, copies/cut/feed directives defaulted.
4. **Wrong labels for this document class.** `Bill To:` (should be *Received From*), `Status: APPLIED` (internal state leaking onto customer paper), `No:` for a receipt number.
5. **The allocation block is not typeset.** `lines.ts:416-442` emits `invoice_number …… amount`, then a raw ISO `  date: 2026-08-04`, then `  bal:`. No column header, no width-aware column plan, abbreviations instead of words, and at 40 mm (24 cols) a long invoice number plus amount overflows. POS items go through `engine/ColumnLayout.ts` + `items.ts` `pickFittingLayout`; the allocation table bypasses that engine entirely. That asymmetry is exactly the visual gap at 58/40 mm.
6. **No per-width degradation.** Because the allocation block never consults the fitting engine, 80 mm and 40 mm print the same plan; POS degrades gracefully, sales receipts do not.
7. **Output policy catalogue is thin and mislabelled.** `useDocumentPrintPolicies.ts:39-53` is a hardcoded 13-entry array; the payment receipt is present but hidden behind the label `Receipts (payments)` with no module grouping — which is why it reads as missing. Absent entirely: goods received note, POS merchant copy, kitchen ticket, purchase return, WMS return. Live data also shows rows the editor itself would now forbid (`customer_statement` = 80 mm ESC/POS bound to an A4 role): the editor validates new edits but nothing repaired the seeded past.
8. **No thermal template variant.** `document_template_ast` holds exactly one `sales.payment_receipt` row, `media_class: a4_portrait`. When the policy asks for 80 mm ESC/POS the engine renders the thermal Line[] path against a template authored for A4 — the blocks that matter on a roll are not modelled.

## Plan

### Phase 1 — Make the snapshot a payment document (no fake items)
- `salesPaymentReceipt.ts`: drop the synthetic `items[]`; `payment_allocations` becomes the sole body. Add `payment_method`, `payment_reference`, `received_from`, `amount_received`, `total_applied`, `unapplied_amount`, `customer_balance_after`, `amount_in_words`. Keep `total = amount_received` for ledger/archive parity.
- Attach the tenant's resolved receipt presentation profile to the snapshot (the same company-level merge POS uses) so branding is frozen at issue time.

### Phase 2 — First-class allocation section in the Line[] engine
- `lines.ts`: replace the ad-hoc allocation block with a section that goes through the same `ColumnLayout` / `pickFittingLayout` machinery as the item grid, with three width plans: 80 mm (doc / date / applied / balance), 58 mm (doc + applied, balance on a wrapped sub-row), 40 mm (doc on its own row, applied right-aligned beneath). Column headers, right-aligned money, dates per `date_format`.
- Emit the payment-document rows: `Received From`, method + reference, `Total applied`, `On account`, `AMOUNT RECEIVED` (emphasised), `Balance after`, optional amount in words, and a `Received by ______` signature line.
- Suppress subtotal/tax/discount and the `Status:` row for this class; suppress the product grid whenever allocations are present.
- `documentToInput.ts`: map the payment scalars into the engine's payment list, label the recipient `Received From`, enable `show_payment_method` for receipts.

### Phase 3 — A thermal template variant
- Migration seeding a `sales.payment_receipt` system template at `media_class: thermal_80` (blocks: header, meta, received-from, allocations, totals, tender, footer) so the thermal path renders an AST authored for a roll while A4 keeps its archive template; resolution picks by requested medium.

### Phase 4 — Output policy catalogue
- Replace the hardcoded `DOCUMENT_TYPES` array with a module-grouped catalogue sourced from `document_kinds`, so the list cannot drift from what the renderer supports. Groups: Sales / Purchasing / POS / Inventory / HR.
- Rename `Receipts (payments)` → `Sales — Payment Receipt (customer)`; add the missing kinds (GRN, POS merchant copy, kitchen ticket, purchase return, WMS return).
- Data-repair migration for contradictory seeded rows (statements pinned to thermal widths / A4 roles) and a sane default for the payment receipt: A4 PDF manual for back-office, with the 80 mm ESC/POS route available per branch.

### Phase 5 — Guardrails
- Golden-file test for the payment receipt at 80/58/40 mm, mirroring `thermal_receipt_golden_test.ts`.
- Architecture test asserting a payment-receipt snapshot contains no synthetic item rows and that the allocation section is the only body section rendered.
- Test asserting every `document_kinds` row with a printable medium appears in the policy catalogue.

## Technical notes
- Files: `src/services/documents/snapshots/salesPaymentReceipt.ts`, `supabase/functions/_shared/receipt/{lines.ts,documentToInput.ts,items.ts,engine/ColumnLayout.ts}`, `src/hooks/useDocumentPrintPolicies.ts`, `src/apps/platform/hardware/PrintPoliciesEditor.tsx`, plus two migrations (thermal template seed; policy catalogue + data repair).
- No change to the A4 archive routing fixed last round: geometry stays a property of the medium. This work changes content and typesetting, not routing.