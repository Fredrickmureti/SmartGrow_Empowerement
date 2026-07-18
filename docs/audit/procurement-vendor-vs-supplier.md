# Procurement — Vendor vs Supplier Architecture Audit

Status: Phase-2 audit (hardening milestone). Companion to
`.lovable/plan.md` §"Phase H+ — Hardening & Architecture Audit" and
ADR-0079 (Procurement Party vs Role).

Every finding below is backed by evidence gathered on 2026-07-18 via
`supabase--read_query` on the live schema and `rg` over `src/`. Nothing
in the source prompt is treated as fact.

---

## 1. Verified current state

### 1.1 Two entities, one supplier

| Concern | `public.contacts` | `public.suppliers` |
| --- | --- | --- |
| Role in the model | Party / identity (ADR-0038) | Procurement lifecycle (Batch A) |
| FK direction | — | `suppliers.contact_id → contacts.id` (1:1) |
| Business scope | `business_id` | `organization_id + business_id` |
| Owns AP defaults | `default_payable_account_id`, `default_expense_account_id`, `default_tax_rate_id`, `withholding_tax_rate`, `tax_id`, `default_currency` | none (deliberate) |
| Owns procurement lifecycle | `supplier_rank` flag only | `category_id`, `lifecycle_state`, `preferred_rank`, `is_preferred`, `default_currency`, `default_incoterms`, `default_payment_term_id`, `default_lead_time_days`, `minimum_order_value`, `hold_reason`, `qualification_*` |
| Referenced by documents | **yes** — every procurement document keys off it | **no** — no transactional FK targets `suppliers.id` |

Evidence:

```sql
-- Every procurement document keys off contacts, not suppliers.
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema='public' AND column_name IN ('vendor_id','supplier_id')
  AND table_name IN ('purchase_orders','bills','rfq_vendors','purchase_returns');
-- → purchase_orders.vendor_id, bills.vendor_id, rfq_vendors.vendor_id
--   (all three are contacts.id references; no supplier_id column exists on any of them)
```

Verdict: this is the correct enterprise pattern (Odoo `res.partner` +
role tables; SAP LFA1 + LFM1). Suppliers is a **specialisation**, not a
replacement.

### 1.2 The `/purchases/vendors` route

`src/apps/purchases/routes.tsx:501` renders
`<Contacts defaultTypeFilter="supplier" />`. It is a **UI alias** over
the Contacts data path — no parallel data model, no parallel writes.
It is the only surface today that surfaces Contact-side vendor fields
(AP account, WHT, tax id) in the Purchases app; Supplier record page
does not.

### 1.3 Governance & SoD (verified)

Registered duties: `asn.manage`, `bill.approve`, `bill.match`,
`grn.receive`, `po.approve`, `supplier_terms.manage`. 43 SoD conflict
rows total.

**Gap found**: `credit.approve` and `credit.apply` duties are NOT
registered, and `apply_vendor_credit_note_atomic` is NOT in `pg_proc`.
The prior plan lists Batch I as "next pickup" — this confirms it never
landed. Deferred: Batch I is queued behind the hardening phase.

### 1.4 RPC surface (verified)

All present, `SECURITY DEFINER` + `search_path=public`:
`approve_purchase_order`, `receive_inbound_shipment`,
`create_goods_receipt`, `match_bill_atomic`,
`match_bill_with_landed_cost`, `apply_vendor_credit_atomic`.
`guard_bill_self_approval` is a plain trigger function (`security
definer=false` is correct here); the enum→text cast fix from H-Verify
is still in place (`prosrc LIKE '%::text%' = true`).

### 1.5 Studio custom fields

`entity_field_configs` has 1 config on `entity_type='contact'` and 1 on
`estimate`. **No** configs on `supplier`. This means retiring the
`/purchases/vendors` UI does not orphan any Studio metadata, but any
future Supplier-specific custom field must be added under
`entity_type='supplier'` — a fresh scope, not migrated.

---

## 2. Findings

### 2.1 Confirmed issues

| # | Finding | Evidence | Owner |
| --- | --- | --- | --- |
| C1 | `SupplierCreatePage.tsx:207` uses literal `placeholder="USD"` instead of inheriting `businesses.base_currency`. | file read | Fixed in H+1 (this phase). |
| C2 | Purchases nav label "Vendors (legacy)" implies the route is deprecated data, but it is a UI alias over Contacts and the only editor for vendor-role Contact fields. | `src/apps/purchases/nav.ts:38`, `routes.tsx:501` | Fixed in H+2 (relabelled "Suppliers (contact view)"). |
| C3 | Dual-key model (documents FK → `contacts.id`; lifecycle FK → `suppliers.id`) is not documented; easy to "fix" by adding `supplier_id` FKs. | schema audit above | Fixed by ADR-0079. |
| C4 | Batch I (vendor credit note FIFO) never landed despite plan claiming it as "next pickup". | `pg_proc` + `governance_duties` audit | Deferred; queued as **Batch I-Deferred** post-hardening. |

### 2.2 Rejected observations (from the prompt)

| # | Observation | Rejection rationale |
| --- | --- | --- |
| R1 | "Supplier should extend / replace Contact." | Rejected. Contact is the shared party across Sales, CRM, Portal, Payroll counterparties (ADR-0038). Merging breaks every non-procurement consumer. Odoo, SAP, Oracle Fusion, and Dynamics 365 all separate party from procurement role. |
| R2 | "AP defaults on Contact are the wrong home; move them to Supplier." | Rejected. `default_payable_account_id`, `default_expense_account_id`, `default_tax_rate_id`, `withholding_tax_rate` are properties of the **party**, not of the procurement relationship. Finance (bill posting), Aged Payables, Vendor Statements, and JE templates already read them from Contact. Moving them would require a synchronised dual write with no functional benefit. |
| R3 | "Vendor accounting defaults inside the Contact creation flow are duplicated work." | Rejected. Contact is the single authoritative home; Supplier deliberately does not duplicate them. The perceived duplication is the *legacy `/vendors` UI showing them alongside Supplier settings* — a UI concern addressed by Batch K-Retire. |
| R4 | "Withholding tax should be hardcoded per localisation, not on the contact." | Partially rejected. WHT **rate** is a per-vendor override; the *statutory tax code / bracket* is per-localisation. Current model correctly places the rate on Contact. Sourcing the default from `localization_packs` is legitimate future work (§2.4). |
| R5 | "Supplier defaults to USD is proof the workspace base currency is ignored everywhere." | Partially rejected. Confirmed for `SupplierCreatePage` (C1). Not confirmed for the platform at large — `businesses.base_currency` is respected by the invoice / bill / journal path and by `BusinessContext` on business creation. |

### 2.3 Migration risks

| # | Risk | Mitigation |
| --- | --- | --- |
| M1 | Deleting a contact that has a linked supplier row would orphan procurement lifecycle. | DB FK `suppliers.contact_id → contacts.id` protects at cascade level. Verify no `ON DELETE CASCADE` on that FK in Batch M. |
| M2 | Studio custom fields on `contact` (1 config) would silently disappear if the Purchases app stopped rendering the Contacts editor. | Do not remove the `/vendors` route until Supplier record page renders the Contact custom-field slot (`entity_type='contact'`). Documented in Batch K-Retire prerequisites. |
| M3 | A well-meaning refactor adding `supplier_id` FKs to documents would break audit lineage on historical bills. | Guarded by ADR-0079 + `src/test/architecture/procurement.test.ts` (extend in Batch M to forbid new `supplier_id` columns on transactional tables). |
| M4 | `businesses.base_currency` defaults to `'USD'` at the schema level. Tenants signing up in KES / EUR silently inherit USD unless the signup flow overrides it. | Out of scope for procurement, but flagged for platform onboarding audit. |

### 2.4 Recommended future work (not in this plan)

- Studio-driven Supplier form (`entity_type='supplier'` field configs) — unblocked by ADR-0079.
- Per-tenant AP account templates (today all AP defaults are per-contact; enterprise tenants want per-category defaults).
- WHT source-of-truth pass: keep the per-contact override but seed defaults from `localization_pack_tax_templates`.
- Reintroduce Batch I (vendor credit note FIFO) once hardening closes.
- Fix `businesses.base_currency` schema default (drop the `'USD'` default; require signup flow to supply it).

---

## 3. Business-process alignment

Modelled against the enterprise reference (Odoo, SAP MM, Oracle Fusion Procurement, Dynamics 365 F&O):

| Business step | System-of-record | Owner module | Current model |
| --- | --- | --- | --- |
| Supplier registration | `contacts` (party) + `suppliers` (role) | Contacts (identity) + Procurement (lifecycle) | ✅ correct |
| Qualification | `supplier_qualifications` | Procurement | ✅ |
| Sourcing (RFQ) | `rfqs`, `rfq_vendors` (→ contact) | Procurement | ✅ |
| Contracts | `procurement_contracts` | Procurement | ✅ |
| Requisition → PO | `purchase_requisitions` → `purchase_orders` (vendor_id → contact) | Procurement | ✅ |
| ASN → GRN → Match | `inbound_shipments` → `goods_receipts` → `bill_match_results` | Procurement (writers) + WMS/Finance (subscribers via outbox) | ✅ |
| Bill approval → posting | `bills` → outbox → Finance `journal_entries` | Procurement raises, Finance owns GL | ✅ (P0 Great Split) |
| Payment | `bill_payments`, `bill_payment_allocations` | Finance | ✅ |
| Statements / Aged Payables | reads `bills` + `contacts` | Finance | ✅ |

No responsibility duplication found between Procurement and Finance
after P0. The `complete_goods_receipt_atomic` split (Procurement raises
event → WMS applies stock → Finance posts JE) matches SAP's IDoc /
Odoo's automated-action pattern.

---

## 4. Verdict

- **Contact ↔ Supplier split is correct and enterprise-aligned.** No refactor needed. ADR-0079 documents the invariants.
- **Legacy `/purchases/vendors` route is not legacy data** — it is a UI shortcut over Contacts that today owns the vendor-role Contact-fields editor. Retire only after Supplier record page absorbs that editor (Batch K-Retire).
- **One real code bug** (C1, currency inheritance) fixed in this phase.
- **One documentation gap** (C3, dual-key model) fixed by ADR-0079.
- **Batch I is confirmed missing** and re-queued.

See `.lovable/plan.md` for the full hardening timeline and Batch M
consolidated verdict.
