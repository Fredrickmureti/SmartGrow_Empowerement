# Sugar simulation — verification verdict and continuation (POS, documents, verdict, fixes)

## Phase 1 — what I verified directly against the live system

Checked in the database and the codebase, not from the hand-off note.

| Prior claim | Verdict | Evidence |
|---|---|---|
| Catalogue wiped, only Sugar exists | Confirmed | one product: Sugar, base UoM KG, one packaging row |
| Opening stock 500 kg received as 10 × 50 kg bags | Confirmed | one `receipt` movement, +500, `source_packaging_id` = the bag |
| Sell 17 kg loose, posted, ledger correct | Confirmed | movement −17, base KG |
| Sell 1 × 50 kg Bag, posted | Confirmed base-correct | movement −50, packaging id present |
| Sweep 2 / 1 / 5 / 25 kg | Confirmed | four movements, all KG |
| Running balance 500 − 100 = 400 kg | Confirmed | `products.stock_quantity` = 400 |
| No `kg → ea` substitution anywhere on the sell path | Confirmed | every movement stamps base code KG |

So steps 1–6 of the parent prompt are genuinely done and arithmetically clean.

Genuinely NOT done (parent prompt steps still open):

- Step 7 — POS: no POS transaction for Sugar exists at all.
- Step 8 — documents: no invoice PDF or receipt has been rendered and read.
- Step 9 — full database trace written up (product → UoM → pack → line → movement → quant → snapshot).
- Generic proof: no volume / length / countable product exists, so "is this generic or does Sugar just happen to work" is unanswered.
- Final structured verdict.

## Defects confirmed (to fix only after the diagnostic run)

1. **`set_invoice_status_atomic` is broken at runtime.** It calls
   `public.user_has_business_access(v_inv.business_id)` with one argument; the
   function signature is `(_user_id uuid, _business_id uuid)`. Every call fails
   with 42883, blocking invoice status changes from the Sales UI. Layer:
   database RPC.
2. **Pack provenance is dropped at the ledger.** The 1-bag sale line carries
   display 1 / pack "50 kg Bag" / factor 50, but the movement written by
   `complete_delivery_atomic` stamps `display_quantity` −50, pack name NULL,
   factor 1. The receipt movement has the same shape (500 kg received as
   10 bags, stamped loose). Base quantity is right; commercial meaning is lost.
   Layer: the movement writers, not the line tables.

## Phase 2 — execution order

**Step A — POS (prompt step 7).** Through the real POS workspace: sell 2 kg
loose, then 1 × 50 kg Bag. Verify cart line wording, `pos_transaction_items`
provenance columns, the resulting stock movement, and on-hand after each.
Confirm POS never renders `2 ea` for a KG product.

**Step B — Documents (prompt step 8).** Render and read the actual invoice PDF
for the 17 kg and 1-bag sales, plus the POS receipt for the 2 kg sale. Compare
printed quantity strings against the in-app formatter. `17 kg`, `1 50 kg Bag
(50 KG)` — a mathematically right number in the wrong unit counts as a failure.

**Step C — Database trace (prompt step 9).** One table per event tracing
product → base UoM → packaging → sales line → movement → quant →
`document_records.snapshot`, naming for each column whether it is canonical,
derived or frozen.

**Step D — Generic proof.** Create through the same product form: Cooking Oil
(base L, 20 L container), Cable (base m), Chair (base ea, no pack). One sale
each — a fractional denomination and a packaged one — and confirm POS refuses
2.5 chairs while allowing 2.5 m of cable.

**Step E — Cross-domain consumer check.** For each of inventory, purchasing,
receiving, sales, invoicing, POS, returns, credit notes, reporting and document
generation, verify the provenance columns are actually selected and rendered —
per domain, not inferred from a sibling.

**Step F — Final verdict** in the requested structure: configuration, events
executed, expected-vs-actual table, layer where semantics are lost, per-domain
impact, architecture verdict, then remediation.

**Step G — Remediation** (only after the diagnostic record is complete), each
item as its own migration or edit plus a guard test:

1. Fix `set_invoice_status_atomic` to pass `auth.uid()` (or the passed
   `p_user_id`) as the first argument; add a SQL guard test that calls it.
2. Make the movement writers carry pack provenance: `complete_delivery_atomic`
   and the receipt writer stamp `display_quantity`, `uom_snapshot_pack_name`
   and `uom_snapshot_factor` from the source line instead of collapsing to
   loose base units. Guard test asserting a 1-bag delivery yields a movement
   with display 1 / factor 50.
3. Close the earlier-identified gaps: `LINE_ITEM_UOM_SELECT` wired into
   requisition, RFQ, WMS return, POS receipt and kitchen ticket; PO trigger
   ordering (normalise before consistency check); `is_sellable` /
   `is_purchasable` on `product_packaging`; `rfq_items` brought into the
   provenance model.

## Diagnostic discipline

Steps A–F are read-and-record. Any failure found is reproduced, traced to its
owning layer and written down — not patched mid-run. All fixes land in step G.

## Technical notes

Browser automation drives the real app on localhost with the injected session;
database checks are read-only queries. No new UoM table, packaging table,
conversion engine or formatter is introduced — everything stays on
`units_of_measure` + `convert_uom` + `product_packaging` +
`resolve_line_base_quantity` + `src/lib/inventory/uom.ts`. Schema changes ship
as migrations with a `supabase/tests/` guard each.
