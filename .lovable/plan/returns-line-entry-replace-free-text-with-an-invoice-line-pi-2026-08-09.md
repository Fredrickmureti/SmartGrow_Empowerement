# Returns line entry — replace free-text with an invoice-line picker

## What you're seeing, and why

You are right that it's wrong, and the cause is worse than a styling choice: **selecting an invoice currently populates nothing at all.**

- `SalesReturnCreatePage.handleInvoiceSelect` reads `invoice.items` off the record it already has in memory.
- `useInvoices` selects `invoices.*` plus `contact:contacts(...)` only — it never selects `items`. So `invoice.items` is always undefined and the branch that builds the return lines never runs.
- Meanwhile the page sets `fromInvoice = !!selectedInvoiceId`, which tells `SalesReturnLineRow` to **hide the product picker** and treat the description as invoice-owned. You end up with one blank line, no selectable product, and a description field as the only thing on screen — a free-text row against an invoice the system knows every line of.

So today the invoice selection is decorative. Everything the server hardened in Phases 1–9 (invoice-line cost basis, tax snapshot, returnable-quantity ledger) depends on `invoice_item_id` being sent — and this screen can't send it.

## What an enterprise system does here

Returns are never authored by typing. In SAP, NetSuite, Dynamics and Oracle the RMA screen is a **"reference document" pick list**: choose the invoice, get its lines in a grid with the still-returnable quantity per line, tick the lines and set quantities. Free text is only allowed for a goodwill/off-invoice return, and that path is explicitly marked as such because it has no cost basis and no tax provenance.

The database already supports exactly this and the UI simply never consumed it: `v_sales_returnable_qty` exposes `invoice_item_id, invoice_id, product_id, invoiced_qty, returned_qty, returnable_qty` — the remaining-returnable ledger, net of prior returns.

## The change

1. **Load invoice lines properly.** Fetch the selected invoice's `invoice_items` on demand (a dedicated query in the returns feature, not a widening of the global `useInvoices` list query), joined against `v_sales_returnable_qty` so each line carries its remaining returnable quantity.
2. **New "Select lines to return" step.** After picking an invoice, show its lines in a picker: product/description, invoiced qty, already returned, returnable, unit price net of the original discount, tax. Checkbox per line, quantity input clamped to `returnable_qty`, "select all" affordance. Lines with `returnable_qty = 0` are shown disabled with a "fully returned" tag rather than hidden, so the user isn't left wondering.
3. **Picked lines become locked provenance lines.** They carry `invoice_item_id`, `max_quantity = returnable_qty`, net unit price and the source tax basis. Product and price are read-only; only quantity, condition and line reason are editable. A small "from INV-xxxx" tag on the row makes the provenance visible.
4. **Free text stays — but as a deliberate second path.** An "Add off-invoice line" action remains available even when an invoice is selected. Those rows keep the full product combobox plus free-text description, and are flagged in the UI as having no invoice provenance (no cost/tax snapshot, approval will price them from current cost). This is the goodwill/no-receipt case, and it should be possible without pretending it's the same thing.
5. **Fix the `fromInvoice` flag.** It becomes per-line (`!!line.invoice_item_id`) instead of per-document, which is what makes points 3 and 4 able to coexist in one grid.
6. **Guard against regression.** Add an architecture ratchet asserting the returns create page never renders an editable product/price control for a line that has an `invoice_item_id`, and never relies on `invoice.items` from the list hook.

## Technical notes

- New: `src/features/sales/returns/useInvoiceReturnableLines.ts` — query `invoice_items` for one invoice + `v_sales_returnable_qty`, keyed by invoice id, org/business/branch scoped.
- New: `src/features/sales/returns/InvoiceLinePickerDialog.tsx` — the pick list.
- Edit: `SalesReturnCreatePage.tsx` — replace `handleInvoiceSelect`'s in-memory `inv.items` read with the new hook + picker; per-line provenance flag; keep the existing `previewLineTax` preview and the server-confirms-tax note.
- Edit: `src/components/documents/lines/SalesReturnLineRow.tsx` — `fromInvoice` derived per line; add the provenance tag and the "no invoice basis" marker.
- No database work. `v_sales_returnable_qty`, `resolve_sales_return_line_tax` and `create_sales_return_atomic` already do the right thing once `invoice_item_id` actually arrives.
