# Supplier / Vendor Domain — Takeover Audit and Completion Wave

The previous agent executed most of the approved reconstruction plan. This plan
records what is verified done, what is genuinely incomplete, and the remaining
work in dependency order. Verification below came from live database
introspection and codebase tracing, not from the old plan's claims.

## 1. Verified state (evidence)

Confirmed present in the database:

- `suppliers` (2 rows) matches exactly the 2 supplier-role contacts; the
  auto-provision trigger `trg_contacts_provision_supplier_role` plus
  `_contacts_provision_supplier_role` / `ensure_supplier_for_contact` keep party
  and role from diverging.
- Full lifecycle RPC set exists: `create_supplier`, `approve_supplier`,
  `block_supplier`, `unblock_supplier`, `archive_supplier`, `unarchive_supplier`,
  `suspend_supplier`, `reinstate_supplier`, qualification submit/approve/reject,
  `sweep_supplier_qualification_expiry`, `_supplier_transition`.
- Master-data RPCs exist: `next_supplier_code` (no null codes remain),
  `update_supplier_terms`, banking add/verify/deactivate,
  `record_supplier_compliance_check`, ASL add/remove,
  `resolve_supplier_defaults`, `resolve_supplier_remittance`.
- Purchase gating is trigger-level: `trg_po_supplier_purchasable`,
  `trg_bills_supplier_purchasable`, `trg_rfq_inv_supplier_purchasable` over
  `_assert_supplier_purchasable`.
- Document snapshots exist: `trg_po_party_snapshot`, `trg_bills_party_snapshot`,
  `trg_po_commercial_fields_immutable`.
- Item terms converged: `supplier_item_terms` is a real table with a validation
  trigger; `vendor_pricelists` is now a **view** with an INSTEAD OF DML trigger.
- New audit surfaces exist: `supplier_lifecycle_events`, `supplier_terms_changes`.
- Purchase returns have a complete RPC lifecycle plus outbox emission.
- Vendor pickers on PO, Bill, RFQ and Vendor Credit Note create/edit pages use
  `usePurchasableVendors`.

## 2. Confirmed remaining gaps

| # | Gap | Evidence | Status |
|---|---|---|---|
| G1 | Two `create_supplier` overloads differing only in parameter order | `pg_proc` shows both signatures | PENDING — ambiguous RPC resolution risk |
| G2 | RFQ v2 columns still named `supplier_id` while referencing `contacts`; no `v_party_supplier` resolution view | `rfq_invitations/quotations/awards/quotation_attachments.supplier_id`; view count 0 | PENDING (was flagged as needing approval) |
| G3 | Purchase Return and Expense create/edit pages still pick vendors from contacts, not the purchasable-supplier set | `PurchaseReturnCreatePage.tsx`, `ExpenseCreatePage/EditPage.tsx` lack `usePurchasableVendors` | PARTIAL |
| G4 | Supplier 360 has no Terms, Item terms, ASL, Payments or Returns tabs, so `update_supplier_terms`, ASL add/remove and `supplier_item_terms` have RPC wrappers but no operator surface | `SupplierRecordPage.tsx` tabs = overview, qualification, compliance, banking, contracts, requisitions, orders, bills | PARTIAL |
| G5 | Item-terms convergence left the legacy write path in place: `useVendorPriceLists.ts` and `productSupplierImportConfig.ts` still write through the compatibility view | hook insert/update/delete on `vendor_pricelists` | PARTIAL |
| G6 | Verification suite is thin: only `supplier-schema-contract.test.ts` (73 lines) and `procurement.test.ts`. No lifecycle-transition, idempotency-replay, concurrency, ASL-enforcement or end-to-end requisition→payment business-event tests; no architecture test banning direct writes to supplier tables or contact-keyed vendor pickers | `src/test/architecture/` listing | PENDING |
| G7 | ASL enforcement has RPCs but no verified reader/gate for restricted categories | no consumer found outside `supplierRpcs.ts` | PENDING |

## 3. Completion wave (dependency order)

**Phase 1 — Database hygiene and identity naming**
1. Drop the superseded `create_supplier` overload, keeping the signature the
   client calls; regression test asserting exactly one overload.
2. Rename RFQ v2 `supplier_id` columns to `vendor_id` (they reference
   `contacts`), update RFQ hooks/pages/types, and add `v_party_supplier`
   resolving party → supplier role for reads that need both.

**Phase 2 — Close the gating surface**
3. Move Purchase Return and Expense vendor selection onto
   `usePurchasableVendors`; add trigger-level purchasable assertions for
   `purchase_returns` and vendor-facing expenses so the gate is server-side too.
4. Implement ASL enforcement: restricted-category sourcing check inside
   `_assert_supplier_purchasable` (or a sibling assertion) invoked from PO and
   RFQ paths.

**Phase 3 — Item terms convergence finished**
5. Repoint `useVendorPriceLists` and `productSupplierImportConfig` at
   `supplier_item_terms` via the supplier-terms RPC/service, then retire the
   `vendor_pricelists` compatibility view and its INSTEAD OF trigger.

**Phase 4 — Supplier 360 completion**
6. Add Commercial terms (writing via `update_supplier_terms`, showing
   `supplier_terms_changes` history), Item terms, Approved supplier list,
   Payments and Returns tabs; surface `supplier_lifecycle_events` as the audit
   timeline on the record page.

**Phase 5 — Verification**
7. Lifecycle tests for every transition and every rejection path.
8. Idempotency tests: replayed RPC yields one outbox row and one lifecycle event.
9. Concurrency tests: double create, double approve, duplicate supplier code.
10. Enforcement tests: suspended/blocked/archived supplier rejected by PO, bill,
    RFQ invitation, purchase return and expense; ASL restriction respected.
11. End-to-end business-event test: requisition → RFQ → PO → GRN → bill →
    payment → return → vendor credit note, asserting one stable supplier identity
    and reproducible snapshots.
12. Architecture tests: no client-side writes to `suppliers` or supplier
    satellite tables; no contact-keyed vendor picker in purchases surfaces.

## 4. Deferred, with reasons (unchanged)

- **Vendor portal identity** stays on contacts/portal users — external
  authentication surface, nothing in this wave depends on it.
- **Supplier performance scoring** needs accumulated GRN quality and on-time
  data; the events and schema hooks exist, the scoring engine stays out.

## 5. Destructive steps in this wave

- Dropping the duplicate `create_supplier` overload.
- Renaming the RFQ v2 `supplier_id` columns to `vendor_id`.
- Retiring the `vendor_pricelists` compatibility view after repointing writers.

Approving this plan authorises those three; everything else runs in dependency
order without further checkpoints.
