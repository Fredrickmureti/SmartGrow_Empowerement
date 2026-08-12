# Supplier / Vendor Domain — Reconstruction (replaces the previous plan)

## 1. Canonical domain model

A supplier is not a record; it is a **party playing a procurement role**, with
governance state, commercial terms, banking, compliance and a financial
obligation history.

| Concern | Canonical owner | Evidence |
|---|---|---|
| Legal/party identity, tax id, addresses | `contacts` | ADR-0038 |
| AP/finance defaults (payable & expense account, tax rate, withholding, credit) | `contacts` | ADR-0079, contacts columns verified |
| Procurement role + lifecycle, procurement defaults (currency, incoterms, payment term, lead time, MOQ, preferred rank) | `suppliers` (1:1 `contact_id`) | ADR-0079 |
| Qualification cycles / documents | `supplier_qualifications`, `supplier_qualification_documents` | exists |
| Compliance checks | `supplier_compliance_checks` | exists |
| Remittance banking | `supplier_bank_accounts` | exists |
| Category sourcing eligibility | `supplier_categories`, `approved_supplier_list` | exists, unused |
| Item-level commercial terms | must be exactly one table | **currently two** |
| Transactional documents (RFQ, PO, GRN, Bill, Payment, Return, VCN) | party = `contacts.id` | all FKs verified |

## 2. What actually exists now (verified)

- `suppliers` has **0 rows**; `contacts` has 3. No vendor-role contact has a
  supplier row, so Supplier 360, qualification, ASL, banking and contracts are
  structurally unreachable for every party the documents actually use.
- All transactional FKs point at `contacts(id)`: `purchase_orders.vendor_id`,
  `bills.vendor_id`, `bill_payments.vendor_id`, `purchase_returns.vendor_id`,
  `vendor_credit_notes.vendor_id`, `expenses`, `inbound_shipments`,
  `stock_lots.supplier_id`, `vendor_pricelists.vendor_id`, and RFQ v2
  (`rfq_invitations`, `rfq_quotations`, `rfq_awards`) — the last three are
  **named `supplier_id` but reference `contacts`**.
- Master satellites point at `suppliers(id)`: `approved_supplier_list`,
  `procurement_contracts`, `supplier_bank_accounts`,
  `supplier_compliance_checks`, `supplier_qualifications`,
  `product_identifiers`, `purchase_requisition_items.suggested_supplier_id`.
- Lifecycle RPCs present: `create_supplier`, `submit/approve/reject_supplier_qualification`,
  `suspend_supplier`, `reinstate_supplier`. Absent: block, unblock, archive,
  direct approve, bank-account add/verify, compliance-check record,
  commercial-terms change, ASL add/remove.
- No trigger on `purchase_orders` / `bills` / `rfq_invitations` gates on
  supplier lifecycle state; no trigger at all on `suppliers` (no audit, no
  updated_at).

## 3. Architectural drift found

1. **Dual-key split with no bridge.** Requisition suggests `suppliers.id`; the
   PO it becomes records `contacts.id`. RFQ award (contacts) converts to PO
   (contacts). Nothing guarantees the party on a document has a supplier row.
2. **Two live supplier-creation paths.** `/purchases/suppliers/new` (RPC,
   correct) and `/contacts-app/vendors` + Global Create "Supplier" + command
   palette, which write `contacts.supplier_rank` directly and create **no**
   supplier row.
3. **Vendor pickers bypass the role.** Every PO/Bill/RFQ/Return/VCN/Expense
   create page selects from `contacts.type='supplier'` — a suspended or
   unqualified supplier is fully purchasable.
4. **Two item-terms engines.** `supplier_item_terms` (keyed `suppliers`, no FK,
   no unique constraint, zero UI) vs `vendor_pricelists` (keyed `contacts`,
   live UI at `/vendor-price-lists`).
5. **Non-idempotent events.** Outbox `idempotency_key` embeds
   `extract(epoch from now())` in every supplier RPC — retries duplicate events.
6. **`approved_supplier_list` is dead** — no reader, no enforcement anywhere.
7. **Banking is decorative** — payments never read `supplier_bank_accounts`; no
   verification transition; `account_number_encrypted` has no writer.
8. **No supplier audit trail and no document snapshots** — an auditor cannot
   reconstruct the terms/name/tax in force when a PO or bill was issued.
9. **`supplier_code` has a uniqueness constraint but no generator** — nullable,
   client-supplied, collides under concurrency.
10. **Lifecycle vocabulary has states with no transitions** (`blocked`,
    `archived`) and qualification has no expiry sweep.
11. **Coverage gaps downstream**: `purchase_returns` has no lifecycle RPC and no
    outbox emission; `approve_bill_atomic` emits no event.

## 4. Traceability verdict

Party → RFQ → PO → GRN → Bill → Payment → Return → VCN is **linkable** (FK chain
is intact through `contacts.id` + document links). It is **not reconstructible**:
no supplier-side change history, no as-of terms on documents, no supplier row for
the parties transacting, and no event for several transitions. Auditor questions
"which terms applied?", "who changed banking?", "what was the previous state?"
cannot be answered today.

## 5. Reconstruction plan (dependency order, one wave)

**A. Party ↔ role convergence (foundation)**
1. Migration: backfill a `suppliers` row for every contact with
   `supplier_rank > 0` or `type in ('supplier','both')`; trigger that auto-creates
   the supplier row whenever a contact gains the supplier role, so the two can
   never diverge again.
2. Rename RFQ v2 columns to `vendor_id` (contacts) so no column named
   `supplier_id` points at `contacts`; add a `supplier_id` resolution view
   `v_party_supplier` for reads that need both.

**B. Lifecycle & governance**
3. Complete the state machine as RPCs: `approve_supplier`, `block_supplier`,
   `unblock_supplier`, `archive_supplier`, plus a qualification-expiry sweep that
   moves `approved → qualifying` when `qualification_expires_at` passes.
4. Deterministic idempotency keys (`<topic>:<entity>:<state>:<cycle>`), and an
   `supplier_events`/audit row + `audit_logs` entry for every transition.
5. Trigger-level purchase gate: PO submit/approve, RFQ invitation and bill
   approval reject parties whose supplier row is `suspended`, `blocked` or
   `archived`; ASL enforcement for categories flagged as restricted.

**C. Supplier master data**
6. `supplier_code` sequencing via the existing document-numbering pattern,
   allocated server-side inside `create_supplier`.
7. Commercial-terms change path: RPC + change-history rows (which changes are
   immediate vs approval-routed, per the governance engine).
8. Banking: add/verify/deactivate RPCs, one primary per (supplier, currency),
   verification is a separate actor from creation (SoD), and payments resolve
   remittance from the verified primary account.
9. Compliance: record-check RPC + expiry sweep feeding the purchase gate.
10. Item terms: keep `supplier_item_terms` as canonical, add the missing FK and
    uniqueness, migrate `vendor_pricelists` data into it, retire the
    `vendor_pricelists` table, hook and page.

**D. Procurement / AP integration**
11. Requisition → RFQ → PO → GRN → Bill: resolve defaults (currency, incoterms,
    payment term, lead time) from the supplier role at document creation, and
    **snapshot** party name, tax id and terms onto PO and Bill at issue time.
12. Close the downstream gaps that break the supplier obligation chain:
    `purchase_returns` lifecycle RPC + outbox, outbox emission on bill approval
    and bill payment.

**E. Surfaces and cleanup**
13. Retire `/contacts-app/vendors` as a supplier surface; Global Create
    "Supplier" and the command-palette action route to
    `/purchases/suppliers/new`; contacts keeps party-level editing only.
14. Supplier 360: qualification, compliance, banking, terms, ASL, contracts and
    the PO/GRN/Bill/Payment/Return history tabs all writing via RPC.
15. Remove dead code and stale types uncovered along the way.

**F. Verification**
16. DB invariants (every supplier-role contact has exactly one supplier row; no
    document party outside the supplier set; one primary bank account),
    concurrency tests (double create, double approve, duplicate code),
    idempotency tests (replayed RPC → one outbox row), lifecycle tests for every
    transition and rejection, an end-to-end requisition→payment business-event
    test, and architecture tests banning direct writes to supplier tables and
    contact-keyed vendor pickers.

## 6. Deferred, with reasons

- **Vendor portal identity** stays on `contacts`/portal users: it is an external
  authentication surface, not procurement state, and nothing in this wave
  depends on it.
- **Supplier performance scoring** requires GRN quality and on-time data that
  only accumulates after receiving runs; the event and schema hooks land in this
  wave, the scoring engine does not.

## 7. Destructive decisions requiring your explicit approval

- Retiring the `vendor_pricelists` table and its page after migrating into
  `supplier_item_terms`.
- Renaming the RFQ v2 `supplier_id` columns.
- Removing `/contacts-app/vendors` from navigation.

Everything else executes in dependency order without further checkpoints.
