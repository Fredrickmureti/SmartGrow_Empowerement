# Supplier / Vendor Master — audit findings and correction plan

## What I verified (evidence, not assumption)

Database (live queries against the project schema):

- `public.contacts` columns include `tax_id`, `type`, `customer_rank`, `supplier_rank`, `commercial_partner_id`, plus the AP/finance defaults (`default_payable_account_id`, `default_expense_account_id`, `withholding_tax_rate`, `tax_exemption_number`, `payment_term_id`). **There is no `tax_number` column.**
- `public.suppliers` columns: `contact_id`, `category_id`, `supplier_code`, `lifecycle_state`, `preferred_rank`, `is_preferred`, `default_currency`, `default_incoterms`, `default_payment_term_id`, `default_lead_time_days`, `minimum_order_value`, `hold_reason`, `qualification_score`, `last_qualified_at`, `qualification_expires_at`. No identity or AP fields — correct.
- Constraints on `suppliers`: `UNIQUE (business_id, contact_id)`, `UNIQUE (business_id, supplier_code)`, FK `contact_id → contacts(id)`, RLS policy `user_has_business_access(auth.uid(), business_id)`, and
  `CHECK (lifecycle_state IN ('draft','qualifying','approved','suspended','blocked','archived'))`.
- Supporting tables exist and are role-scoped, not duplicated identity: `supplier_categories`, `supplier_qualifications`, `supplier_qualification_documents`, `supplier_compliance_checks`, `supplier_bank_accounts`, `supplier_item_terms`, `approved_supplier_list`.
- Lifecycle RPCs exist and are SECURITY DEFINER: `submit_supplier_qualification`, `approve_supplier_qualification`, `reject_supplier_qualification`, `suspend_supplier`, `reinstate_supplier`, plus `discover_supplier_identity`.
- `select lifecycle_state, count(*) from suppliers` returns **zero rows** — no supplier has ever been created successfully in this workspace.

Code:

- `src/features/purchases/suppliers/useSuppliers.ts` selects `contact:contacts(id, name, email, phone, tax_number)`.
- `SupplierCreatePage.tsx` inserts `contacts` then `suppliers` from the browser, with `lifecycle_state: "prospect"`.
- `SupplierRecordPage.tsx` / `useSupplierRecord.ts` already read the correct `contact.tax_id`.
- `SupplierListPage.tsx` and the `SupplierRow` type use the state vocabulary `prospect / qualifying / qualified / active / suspended / retired`.
- ADR-0079 and ADR-0038 already declare the intended model: **Contact is the party; Supplier is the procurement role, 1:1 via `contact_id`; all procurement/AP documents key off `contacts.id` (`vendor_id`).**

## Verdict

**Not fragmented — drifted.** There is exactly one canonical supplier identity (Contact = party, Supplier = procurement role), and every procurement/AP document (`purchase_orders.vendor_id`, `bills.vendor_id`, `rfq_vendors.vendor_id`, `purchase_returns.vendor_id`, `vendor_credit_notes`) keys off the contact. The Contacts "is a customer / is a supplier" dual-role model is correct enterprise behaviour and matches the Odoo/SAP business-partner pattern. There is no second supplier table, no duplicate numbering, no competing AP identity.

What is broken is the **Supplier feature slice's contract with the schema** — the UI layer was written against an earlier draft of the table and never reconciled:

1. **Read drift (the landing-page failure):** `useSuppliers.ts` asks PostgREST for `contacts.tax_number`. That column does not exist; tax identity lives on `contacts.tax_id` and is owned by the party, per ADR-0079. PostgREST rejects the whole embed → "Failed to load suppliers". This is a stale consumer, not a missing column. Nothing should be added to `contacts`.
2. **Write drift (silent, worse):** the create page writes `lifecycle_state: 'prospect'`, which the CHECK constraint rejects. Combined with the empty table, this means supplier creation has never worked. The list page's filter vocabulary (`prospect/qualified/active/retired`) is likewise from the dead vocabulary and would never match a real row.
3. **Server-authority gap:** supplier creation is a two-statement client-side sequence with no transaction. A failure on the second insert leaves an orphan supplier-typed contact. It also always creates a *new* contact, so making an existing customer contact into a supplier produces a duplicate party — which breaks the dual-role model the Contacts form already supports correctly. Every other supplier state transition already goes through a SECURITY DEFINER RPC; creation is the one hole.

## What I will change

Scope is deliberately narrow: converge the drifted slice onto the schema and ADR-0079. No new tables, no new supplier entity, no schema additions to `contacts`.

### 1. Fix the read path (unblocks the landing page)
- `useSuppliers.ts`: embed `tax_id` instead of `tax_number`; update `SupplierRow.contact` accordingly.
- Align `SupplierRow.lifecycle_state` to the real union: `draft | qualifying | approved | suspended | blocked | archived`.

### 2. Align the lifecycle vocabulary end-to-end
- `SupplierListPage.tsx`: state filter options and badge tone map rebuilt on the real six states; the "active" branch in the row actions becomes "approved".
- `SupplierRecordPage.tsx`: tone map, the `canSubmit` gate, and the empty-state/dialog copy switched off `prospect/qualified/active` onto `draft/qualifying/approved`.

### 3. Make supplier creation server-authoritative and idempotent
Add one migration creating `public.create_supplier(...)` — SECURITY DEFINER, business-scoped, single transaction:
- verifies the caller has business access;
- **upserts the party**: if an existing contact is passed (or matched), sets `supplier_rank = 1` and refreshes the mirrored `type` per ADR-0038 rather than inserting a duplicate; otherwise inserts the contact;
- inserts the supplier row at `lifecycle_state = 'draft'`;
- relies on the existing unique constraints for concurrency safety and returns the existing supplier id on conflict (idempotent retry);
- emits the same `supplier.*` outbox event shape the other lifecycle RPCs use.

`SupplierCreatePage.tsx` then calls it through a new wrapper in `supplierRpcs.ts` and drops its direct table inserts. The form also gains an optional "link an existing contact" path so the customer-who-is-also-a-supplier case resolves to one party.

### 4. Field ownership on the create form
Per ADR-0079, identity fields (legal name, email, phone, tax ID, notes) are written to the **contact**; procurement fields (code, category, currency, incoterms, lead time) to the **supplier**. That split is already what the page does — it stays, but the RPC becomes the enforcer instead of the browser. AP defaults (payable account, withholding, payment terms) stay on the contact and are not duplicated onto the supplier form.

### 5. Regression guard
An architecture test asserting the supplier feature slice never references `tax_number` and never uses a lifecycle state outside the CHECK-constraint set, so this class of drift fails CI instead of the landing page.

## Deferred, with reasons

- **Supplier-code sequencing.** Today the code is free text with a per-business unique constraint. A server-side sequence is a real improvement but is a separate change; the unique constraint already prevents collisions.
- **Historical snapshots on issued documents.** Worth a dedicated audit — the party-name-change-after-PO question spans the whole document layer, not the supplier slice.
- **Retiring the legacy `/purchases/vendors` contact view.** ADR-0079 already queues this as "Batch K-Retire"; the nav comment says the route now redirects to `/purchases/suppliers`.
