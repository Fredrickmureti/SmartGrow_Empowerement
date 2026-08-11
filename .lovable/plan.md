# Purchase Returns — verification result and remaining work

## Phase 1: verification of the previous engineer's claims

I re-checked every Phase 1–8 claim directly against the database and the code.

**Confirmed correct (evidence checked):**
- Lifecycle commands all exist in the database: `purchase_return_create / update_draft /
  submit / approve / reject / cancel / dispatch / acknowledge / raise_credit / close`,
  plus `purchase_return_returnable_lines`, `_purchase_return_guard`,
  `_mirror_approval_to_purchase_return`.
- Client write access really is revoked: `authenticated` has SELECT but **not** INSERT on
  `purchase_returns` / `purchase_return_items`; the guard trigger additionally refuses any
  direct DML that does not come from a lifecycle command.
- Traceability is real: the returnable ledger derives from goods-receipt lines and excludes
  rejected/cancelled returns; a goods return cannot be created without a receipt line;
  line price is forced to the receipt landed cost (an operator cannot invent a price).
- Stock leaves only at dispatch, once — a second dispatch is refused because movements for
  the return already exist. Debit note is raised through the existing vendor-credit engine
  and is idempotent (returns the existing note).
- Numbering is business-scoped, taken under an advisory lock, and backed by a unique index
  on `(business_id, return_number)`.
- All Phase 8 UI files exist and behave as described: `purchaseReturnRpcs.ts` is the only
  mutation surface (every other file that touches the tables reads only), the create page
  clamps to returnable quantity and separates goods vs financial returns, the edit page
  passes `row_version`, and the list/peek/view surfaces are read-only.

**Confirmed still missing:**
- No architecture guard test for purchase returns anywhere in `src/test/architecture/`.
- No pgTAP coverage for purchase returns in `supabase/tests/`.
- No supplier-facing RMA document dispatch or notification wiring.

**New problems found during verification (not in the previous plan):**
1. **Concurrent over-return is possible.** The returnable check reads the ledger without
   locking the receipt line, so two simultaneous submissions can each pass the check and
   together return more than was received.
2. **Legacy statuses are still legal.** The status constraint still accepts `pending` and
   `processed` alongside the real lifecycle. There are currently **zero** purchase-return
   rows in the database, so this can be tightened with no data migration at all — the
   previous plan's "legacy data decision" item is obsolete.
3. **Numbering falls back to scanning existing numbers** rather than using a number series.
   It is safe today (advisory lock + unique index) but it is the same pattern flagged
   elsewhere in the ERP, so it needs a regression test pinning the behaviour.

## Phase 9 — invariants, ratchets and tests

Database migration:
- Lock the source receipt line while validating returnable quantity, so concurrent returns
  serialise and the invariant `returned ≤ received` holds under load.
- Drop `pending` / `processed` from the allowed status list (no rows exist).

Tests:
- Architecture guard test mirroring the WMS returns guard: fails the build if any client
  file writes `purchase_returns` / `purchase_return_items`, moves stock for a return, or
  creates a vendor debit note outside the lifecycle commands.
- pgTAP coverage: over-return rejected, concurrent over-return rejected, dispatch moves
  stock exactly once, `raise_credit` idempotent, approver cannot be the submitter,
  numbering unique per company under concurrent creation.

## Phase 10 — supplier paperwork and notification

- Seed the `purchases.return` document template so the RMA/return note renders as a
  quantity-and-reason document rather than falling back to an invoice-shaped layout.
- Wire the existing document + email infrastructure so dispatch can send the return note
  to the supplier, and the raised debit note is available to send, from the record view —
  no new email or document engine.
- Emit the supplier-notification event through the existing outbox rather than sending
  from the page.

## Phase 11 — closing the audit loop (new)

- Surface the full reconstruction on the record: source PO / receipt / bill links, lot and
  serial per line, who approved under which governance mode, dispatch and acknowledgement,
  debit note and its application against the supplier bill.
- Add the returned-quantity ledger to the goods receipt view, so a receipt shows what has
  already gone back.

## Technical notes

- All changes stay server-authoritative: new invariants go into the existing
  `SECURITY DEFINER` commands, never into the React layer.
- Two database migrations (row-lock on the returnable check; status constraint tightening),
  one seed for the return document template.
- No new engines: governance, inventory movement, vendor credit, documents and email all
  remain the existing canonical ones.
