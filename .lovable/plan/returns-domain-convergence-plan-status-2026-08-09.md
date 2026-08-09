# Returns Domain — Convergence Plan & Status

Last updated: 2026-08-09
Active phase: **Phase 8 (tax fidelity & fiscal transmission)** — Phases 1-7 re-verified against the live database by the incoming engineer.

## Verdict recap

The platform runs **two** return engines: the WMS RMA engine (`wms_return_orders`,
full inspection/disposition lifecycle) and the Sales finance engine
(`sales_returns` -> credit note / refund). The convergence keeps both engines but
gives each a single, non-overlapping responsibility:

- **WMS owns physical goods** (receipt, inspection, disposition, stock movement).
- **Sales owns the financial document** (credit note, refund, tax, AR effect).
- A WMS-sourced `sales_returns` row never moves stock; a sales-raised one does.

---

## Independent verification of Phases 1-7 (2026-08-09)

Checked directly against the live database and source, not the log.

Confirmed present and behaving as claimed:
- `sales_returns.wms_return_order_id` + `idx_sales_returns_wms_return_order`;
  `approve_sales_return_atomic` skips all inventory work when the return is
  WMS-sourced, and refuses a closed accounting period.
- `v_sales_returnable_qty`, `trg_enforce_sales_return_qty_ledger`, and the
  `FOR UPDATE` re-validation loop inside `approve_sales_return_atomic`.
- `create_sales_return_atomic(_payload jsonb)` derives totals server-side and
  dedupes on `client_request_id`; `uq_sales_returns_org_number` and
  `uq_sales_returns_client_request` both exist; `trg_assign_sales_return_number`
  is the single number allocation point.
- `transition_sales_return` enforces the FSM, refuses `approved`, and (Phase 7)
  refuses `received -> refunded` until the credit note exists, is issued, and
  `amount_applied + refund_amount >= total`.
- Phase 5 policies: the four `sales_return_items_*_v2` policies are installed.
- Phase 6: `sales_return_cost_basis`, `sales_return_cost_allocations`,
  `resolve_sales_return_line_cost(...)` all exist and are wired into approval.
- Phase 7: `v_sales_return_settlement` exists as a view.

Verdict: **Phases 1-7 are genuinely implemented.** No rework required. Two new
findings were surfaced during verification and are folded into Phase 8 below.

---

## Phase status (1-7 complete — detail retained)

### Phase 1 — Kill double restocking (DONE, verified)
### Phase 2 — Returnable quantity ledger (DONE, verified)
### Phase 3 — Server-owned creation, numbering, idempotency (DONE, verified)
### Phase 4 — Lifecycle enforcement (DONE, verified)
### Phase 5 — Access parity, provenance and guardrails (DONE, verified)
### Phase 6 — Cost basis fidelity (DONE, verified)
### Phase 7 — Settlement & refund completeness (DONE, verified)

(Full narrative for these phases is preserved in
`.lovable/plan/` archives; the objects listed under verification above are the
acceptance surface.)

---

## Phase 8 — Tax fidelity & fiscal transmission (ACTIVE)

### Evidence gathered

1. **Return tax is not the invoice's tax.** `create_sales_return_atomic` copies
   `tax_rate`/`tax_amount` straight from the client payload
   (`COALESCE(NULLIF(it->>'tax_amount','')::numeric, 0)`), and
   `SalesReturnCreatePage` computes them in the browser — from the invoice line
   when a line is picked from the invoice, but from the **product's current**
   rate (`scanTaxRate`) when a line is scanned or added manually. A rate change
   between sale and return therefore reverses the wrong tax.
2. **Discount is dropped.** The RPC derives `line_total` as
   `quantity * unit_price`; `invoice_items.discount_percent` is not applied, so a
   discounted sale can be credited for more net revenue than it earned.
3. **No tax provenance on the reversal chain.** `invoice_items` carries
   `etims_tax_code` and `etims_classification_code`; neither
   `sales_return_items` nor `credit_note_items` has them, so the credit note
   cannot transmit the codes the original invoice used.
4. **Double fiscal enqueue.** `tg_sales_return_fiscal_enqueue` enqueues
   `fiscal.receipt_required` for the `sales_returns` row on `approved`, and
   `tg_credit_note_fiscal_enqueue` enqueues again for the credit note that the
   same approval creates. Idempotency keys differ by `source_doc_type`, so
   dedupe does not catch it: one economic reversal, two fiscal documents. No
   fiscal transmission rows exist yet in this environment, so this is fixable
   without a data repair.
5. **No back-reference to the original invoice's fiscal document.**
   `fiscal_transmissions` has no "original document" column; a credit-memo
   transmission cannot cite the invoice's `fiscal_number` / control-unit id,
   which most fiscalisation regimes require on a credit note.

### Objectives

- The return reverses the tax the **original invoice line** charged (rate,
  amount, tax code, classification), proportional to the returned quantity and
  net of the original line discount.
- Rounding is settled once at document level so line rounding never drifts the
  output-tax control account.
- Exactly one fiscal document per economic reversal, carrying the original
  invoice's fiscal reference.

### Work

**8.1 Snapshot the invoice line's tax basis (DB)**
- Add to `sales_return_items`: `source_tax_rate numeric`,
  `source_tax_amount numeric`, `source_discount_percent numeric`,
  `etims_tax_code text`, `etims_classification_code text`,
  `tax_basis_source text` (`invoice_line` / `product_current` / `manual`).
- New `resolve_sales_return_line_tax(_invoice_item_id, _qty)`: returns the
  proportional net amount and tax for the returned quantity, computed from the
  invoice line (`unit_price`, `discount_percent`, `tax_rate`, `tax_amount`),
  plus the eTIMS codes. Proportion = returned qty / invoiced qty, using the
  invoice line's **stored** `tax_amount` so historic rounding is honoured.
- `create_sales_return_atomic` calls it for every line that has an
  `invoice_item_id`, **ignoring** any client-supplied tax; lines without an
  invoice line keep the supplied rate but are stamped
  `tax_basis_source = 'manual'`. Header `subtotal`/`tax_amount`/`total` are
  re-derived from the resolved values, with a single document-level rounding
  adjustment to 2 dp applied to the largest tax line.

**8.2 Carry the basis into the credit note (DB)**
- Add `etims_tax_code` / `etims_classification_code` to `credit_note_items`.
- `approve_sales_return_atomic` and `create_credit_note_atomic` propagate the
  snapshot columns from the return line rather than recomputing.

**8.3 One fiscal document per reversal (DB)**
- Drop `trg_sales_return_fiscal_enqueue`. A `sales_return` is an internal
  document; the **credit note** is the fiscal artefact. WMS-sourced returns
  reach the same place through the credit note.
- Add `original_transmission_id uuid` (FK to `fiscal_transmissions`) and
  `original_fiscal_number text` to `fiscal_transmissions`; when the enqueued
  document is a credit note with an `invoice_id`, resolve the invoice's latest
  successful transmission and stamp both, and include them in the payload.

**8.4 Client (presentation only)**
- `SalesReturnCreatePage` stops computing tax for invoice-sourced lines: it
  displays the server-resolved tax returned by the RPC and shows the basis
  (`From invoice` vs `Current product rate`) per line.
- Record page and peek sheet show the tax basis and, when present, the fiscal
  reference of the credit note.

**8.5 Guards and tests**
- Extend `src/test/architecture/sales-returns-single-writer.test.ts`: ban
  client-side tax computation for lines that carry an `invoice_item_id`.
- Extend `supabase/tests/sales_returns_convergence_test.sql` (22 -> ~28):
  the new columns and resolver exist; sell at rate A, change the product rate,
  return, and assert the reversed tax equals A; a full return nets the
  output-tax control account to zero; a discounted invoice line credits the
  discounted net; exactly one `fiscal.receipt_required` outbox row exists per
  approved return.

### Migration / compatibility
- All new columns are nullable and additive; existing rows keep NULL and read as
  `tax_basis_source = 'manual'` (backfill from `invoice_items` where an
  `invoice_item_id` is present, best-effort, in the same migration).
- Dropping the sales-return fiscal trigger is safe: no fiscal transmissions or
  outbox rows currently reference `sales_returns`.

### Regression risk
- Medium on totals: returns created after 8.1 may total differently from the
  browser preview until 8.4 lands, so 8.1 and 8.4 ship together.
- Low elsewhere: credit-note posting, settlement and cost basis are untouched.

---

## Phase 9 — Backlog surfaced during verification (not started)

1. `create_sales_return_atomic` accepts `unit_price` from the client even for
   invoice-sourced lines; after 8.1 the price should also come from the invoice
   line, leaving the browser to send only product/quantity/reason.
2. `approve_sales_return_atomic` dates the credit note at `CURRENT_DATE` rather
   than the return date, which can push a reversal into a different period from
   the return it settles.
3. Data-quality sweep: malformed `SR-YYYY-YYYYNNNN` numbers, WMS-sourced returns
   that also carry `stock_movements`, and `refunded` returns whose settlement is
   short are pre-fix damage and need a repair migration, not a code change.

**Rules for this domain.** Never reintroduce client-side inserts into
`sales_returns`/`sales_return_items`, client status writes, or a second restock
path. Cost basis comes from `resolve_sales_return_line_cost`; settlement truth
comes from `v_sales_return_settlement`; tax truth comes from the invoice line
snapshot. All journal effects go through `post_journal_entry_atomic` (ADR 0123).
