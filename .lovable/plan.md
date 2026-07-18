
# Procurement Reconstruction — Verification & Continuation Plan

**Status (2026-07-18): CLOSED.** All batches A–N landed on the live DB.
Consolidated verdict: `docs/audit/procurement-verdict.md`.


## Phase 1 — Verification of prior work (done in this turn)

Re-ran the pre-plan reads the previous engineer left in `.lovable/plan.md §5`. Nothing is asserted below that a query did not confirm.

### Confirmed correct

- **All 12 canonical RPCs present** on the live DB: `approve_purchase_order`, `receive_inbound_shipment`, `create_goods_receipt`, `match_bill_atomic`, `match_bill_with_landed_cost`, `confirm_bill_atomic`, `record_bill_payment_atomic`, `post_journal_entry_atomic`, `void_journal_entry_atomic`, `sync_po_line_billed_quantities`, `apply_vendor_credit_atomic`. Feature batches A–H are landed.
- **43 SoD conflict rows** in `governance_sod_conflicts`; the 6 procurement duties `po.approve`, `asn.manage`, `grn.receive`, `bill.approve`, `bill.match`, `supplier_terms.manage` are all present.
- **ADR-0079 party-vs-role holds**: every procurement document (`purchase_orders`, `bills`, `rfq_vendors`, `purchase_returns`, `vendor_credit_notes`) keys off `vendor_id → contacts.id`. No `supplier_id` FK leaked into transactional tables.
- **H+1 code fix survived**: `SupplierCreatePage.tsx` seeds currency from `currentBusiness.base_currency` inside a `useEffect` (lines 50–56).
- **Studio inventory**: 0 `entity_field_configs` for `supplier`, 1 each for `contact` and `estimate` — matches §3 row 6.
- **Architecture guard tests exist**: `src/test/architecture/procurement.test.ts`, `purchases-branch-scope.test.ts`, `purchases-branch-id-stamping.test.ts`, `purchases-record-dialog-ban.test.ts`.

### Confirmed still open (matches §1.3)

- **G1** `apply_vendor_credit_note_atomic` missing from `pg_proc`.
- **G2** `governance_duties.credit.approve` and `credit.apply` missing.
- **G3 / G4** Supplier record page has no Finance-defaults section and no Contact custom-field slot.

### New findings the previous plan under-specified

1. **`apply_vendor_credit_atomic` already exists** and single-bill VCN application already runs through it (see `src/lib/purchases/applyVendorCredit.ts`, `useVendorCreditNotes.ts`, and `docs/PURCHASES_AUDIT.md §4.6`). Batch I-Deferred is therefore an **upgrade to FIFO multi-bill + outbox emission + dedicated SoD duties**, not a from-scratch build. The old RPC must be **removed in the same migration** so we don't ship two VCN-application code paths (architectural drift is one of the parent prompt's red lines).
2. **Bill balance column mismatch.** Plan §5 references `bills.balance_due`; that column does not exist. `bills` has `total` + `amount_paid`; remaining balance is `total - amount_paid`. The Batch I-Deferred RPC contract below uses that instead.
3. **`vendor_credit_notes.status` is `text`, not an enum.** A status guard (draft → approved → applied/void) must be enforced by trigger or CHECK inside Batch I-Deferred; otherwise the FIFO RPC can be called on a draft.
4. **Callers must be migrated in the same batch.** Deleting `apply_vendor_credit_atomic` without updating `src/lib/purchases/applyVendorCredit.ts` and `src/hooks/useVendorCreditNotes.ts` in the same turn breaks the VCN application UI. Batch I-Deferred is (migration + client rewrite + architecture-guard update), not migration-only.
5. **PURCHASES_AUDIT §7 P3 constraints never landed.** Cross-table triggers (`bill.branch_id ∈ bill.business_id`, `bill.purchase_order_id.business_id = bill.business_id`, VCN↔bill business equality) are still enforced only at the app layer. Adding them as DB constraints belongs in the hardening arc. **Appending as new Batch N-Constraints, queued after Batch M.**

## Phase 2 — Plan status after verification

The existing roadmap (§2 of `.lovable/plan.md`) is fundamentally correct. Adjustments:

- Batches A–H, H-Verify, Phase 1, Phase 2, H+1, H+2, H+3, H+4 — verified complete, no rework.
- Batch I-Deferred contract is rewritten below to reflect findings 1–4.
- Batch N-Constraints appended (finding 5).
- Chronological order preserved: **I-Deferred → K-Retire → L → M → N-Constraints**.

## Phase 3 — Execution

Resume at **Batch I-Deferred** (the last genuinely-completed milestone is H+4). Do not open unrelated procurement work.

### Batch I-Deferred — Vendor Credit Note FIFO (next milestone)

Single migration + coordinated client rewrite + guard-test update, landed together.

**Migration**
- Add duties: `credit.approve`, `credit.apply` to `governance_duties`.
- Add SoD conflicts: `credit.approve ↔ bill.approve`, `credit.apply ↔ credit.approve`, `credit.apply ↔ bill.match`.
- Add status guard trigger on `vendor_credit_notes` restricting transitions to `draft → approved → applied|void` (and `approved → void`).
- Create `apply_vendor_credit_note_atomic(p_credit_note_id uuid, p_bill_ids uuid[])`:
  - `SECURITY DEFINER`, `SET search_path = public`.
  - Locks credit note (`FOR UPDATE`); rejects unless `status='approved'` and `total - amount_applied > 0`.
  - Restricts candidate bills to same `organization_id + business_id + vendor_id + currency`, `status IN ('received','partial')`, `total - amount_paid > 0`.
  - **FIFO** = `due_date ASC NULLS LAST, created_at ASC`, intersected with `p_bill_ids` if provided (otherwise all eligible).
  - For each bill: apply `min(credit_remaining, total - amount_paid)`; insert `vendor_credit_note_applications`; update `bills.amount_paid` and `bills.status` (`paid` when balance hits 0, else `partial`); decrement credit remaining.
  - Sets `vendor_credit_notes.status = 'applied'` when fully consumed; keeps `approved` with `amount_applied > 0` when partial.
  - Emits **one** `procurement.credit.applied` row to `business_event_outbox` with idempotency key `credit.applied:<credit_note_id>:<vcn.updated_at epoch>`. Payload lists per-bill allocations. **Never** writes `journal_entries`, `journal_entry_lines`, `stock_movements`, `cost_layers` (Finance subscribes via outbox — same contract as Sales domain).
- **Drop `apply_vendor_credit_atomic`** in the same migration.
- Rollback-marker smoke: seed 1 VCN + 3 bills → apply → assert FIFO order, idempotency (2nd call is no-op), SoD blocks approver applying, `__SMOKE_ROLLBACK_MARKER__` present, no rows in `journal_entries` from the RPC.

**Client rewrite (same turn as migration approval)**
- `src/lib/purchases/applyVendorCredit.ts` → call new RPC with `(p_credit_note_id, p_bill_ids)`; drop the single-bill signature.
- `src/hooks/useVendorCreditNotes.ts` → surface multi-bill selection; invalidate `bills`, `vendor_credit_notes`, `vendor_credit_note_applications`.
- UI: extend the existing VCN apply dialog to allow multi-bill selection with a "FIFO auto-select" toggle.
- `src/test/architecture/procurement.test.ts` → extend writer allow-list for `apply_vendor_credit_note_atomic` and remove `apply_vendor_credit_atomic`.

**Definition of done**
- Both queries return rows: `SELECT 1 FROM pg_proc WHERE proname='apply_vendor_credit_note_atomic'` and `SELECT 1 FROM pg_proc WHERE proname='apply_vendor_credit_atomic'` returns **empty**.
- `SELECT duty_code FROM governance_duties WHERE duty_code LIKE 'credit.%'` returns 2 rows.
- Smoke migration idempotent; `procurement.test.ts` green.
- `.lovable/plan.md §1.2 / §1.3` updated to close G1 + G2.

### Batch K-Retire — Supplier record page absorbs `/purchases/vendors`

Blocked on I-Deferred. Scope:
- Add **Finance Defaults** section to `SupplierRecordPage`: AP account, expense account, WHT rate, tax id, payment terms — writes back to the `contacts` row (party record, per ADR-0079).
- Render Contact custom-field slot (`entity_field_configs.entity_type='contact'`) inside the Supplier record page.
- Then delete `/purchases/vendors` route + nav entry.

### Batch L — Playwright coverage

- H+1 currency inheritance on supplier create.
- H-Verify self-approval guard regression (bill approver ≠ bill creator).
- K-Retire: `/vendors` no longer resolves; Supplier record page shows Finance Defaults + custom field.
- I-Deferred happy path: 1 VCN → 3 bills → FIFO apply → outbox row present, `journal_entries` count unchanged by RPC (Finance saga writes it separately).

### Batch M — Consolidated verdict doc

- Publish `docs/audit/procurement-verdict.md`; flip Phase H+ to **CLOSED** in `.lovable/plan.md §1.2`.

### Batch N-Constraints — DB-level cross-table integrity (new)

Row-level triggers currently enforced only by app code + RLS (PURCHASES_AUDIT §7 P3):
- `bill.branch_id.business_id = bill.business_id` (+ same for `purchase_orders`, `vendor_credit_notes`, `bill_payments`, `journal_entries`).
- `bill.purchase_order_id.business_id = bill.business_id`.
- `vendor_credit_note_applications`: `vcn.business_id = bill.business_id`.

Live DB is already clean (PURCHASES_AUDIT §5); triggers only fire on future bad writes.

## Technical guardrails (carry-forward from parent prompt)

- No client-side GL. Procurement never inserts into `journal_entries`, `stock_movements`, or `cost_layers` directly — always via canonical RPC or outbox event.
- No `supplier_id` FK on any transactional document (ADR-0079).
- Every new public-schema table needs GRANTs in the same migration.
- New RPCs are `SECURITY DEFINER` + `SET search_path = public` + `SoD-guarded`.
- Any RPC that mutates `bills` or `vendor_credit_notes` must lock the target row `FOR UPDATE` before reading its state.

## Out of scope for this arc

Sourcing 2.0, Supplier Portal enhancements, WMS crossovers, Manufacturing hooks. Queued behind Batch N-Constraints.
