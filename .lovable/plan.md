
# Procurement Domain — Hardening, Migration & Architecture Audit

The feature-build phase for Procurement (Batches A–H + H-Verify) is complete. This plan transitions the roadmap into **enterprise hardening**: verify what actually shipped, produce an evidence-backed architecture audit of the Contact ↔ Supplier ↔ Vendor overlap, and lay down a safe legacy-retirement path. No refactor happens before the audit lands.

## Phase 0 — Reset `.lovable/plan.md`

Rewrite the "Next pickup" section to reflect the milestone: feature scope closed, hardening phase opened. Preserve the existing execution log verbatim (Batches A–H, H-Verify). Add a new top-level section "Phase H+ — Hardening & Architecture Audit" whose sub-phases are the remainder of this plan.

## Phase 1 — Independent verification of claimed Procurement state (read-only)

Treat every "LANDED" entry as unverified. Evidence gathered via `supabase--read_query` + `rg`; results appended to `.lovable/plan.md` execution log as pass / fail with the query output.

1. **RPC surface** — every canonical writer from Batches E–H exists in `pg_proc` with `security definer` + `search_path=public`: `approve_purchase_order`, `receive_inbound_shipment`, `create_goods_receipt`, `match_bill_atomic`, `match_bill_with_landed_cost`, `apply_vendor_credit_atomic`, plus SoD guards.
2. **Governance** — `governance_duties` contains `po.approve`, `asn.manage`, `grn.receive`, `bill.approve`, `bill.match`, `supplier_terms.manage`, `credit.approve`; `governance_sod_conflicts` carries the 3-way separations documented in the execution log.
3. **Outbox contract** — every procurement RPC emits `procurement.*|supplier.*|sourcing.*` with idempotency key `<event>:<entity>:<state>`; sample 20 rows from `business_event_outbox` where `source='procurement'` to confirm.
4. **Boundary guard** — `src/test/architecture/procurement.test.ts` still forbids procurement RPCs from touching `stock_movements`, `journal_entries`, `cost_layers`; extend the guard list with `bill_match_results` (writer allow-list = the two H RPCs only).
5. **RLS** — every P1–H table has `business_id` predicate; branch-scoped tables pass `v_branch_scoped_policy_check`. Any offender is downgraded from LANDED and repaired in Phase 6 before audit publish.
6. **Batch H drive-by** — confirm `guard_bill_self_approval` still carries the enum→text cast fix; add a Playwright regression to Batch L.

Deliverable: verification log table in `.lovable/plan.md` (pass / fail / evidence per item). No code changes in this phase.

## Phase 2 — Contact ↔ Supplier ↔ Vendor architecture audit

Produce `docs/audit/procurement-vendor-vs-supplier.md`. The audit answers, with evidence, the questions the user raised. Confirmed baseline from this exploration (to be expanded, not re-litigated, during the audit):

- **`contacts` is the identity system of record** (ADR-0038). It already carries `default_payable_account_id`, `default_expense_account_id`, `default_receivable_account_id`, `default_tax_rate_id`, `default_currency`, `withholding_tax_rate`, `tax_id`, `supplier_rank`, `customer_rank`. Removing AP defaults from Contacts would break Finance, Statements, and every consumer that already reads them.
- **`suppliers` is a specialised business role** 1:1 with `contacts` via `contact_id` (P1 migration), carrying procurement-only lifecycle: category, qualification, preferred rank, hold state, incoterms, lead time, default currency, minimum order value, payment term. It correctly does not duplicate AP account / WHT / tax id.
- **All procurement documents still key off `contacts.id`** — `purchase_orders.vendor_id`, `bills.vendor_id`, `rfq_vendors.vendor_id`, `purchase_returns.vendor_id`, `vendor_credit_notes` all reference contacts. `suppliers.id` is NOT used as an FK on any document. This is intentional (audit lineage) but must be documented so nobody "fixes" it.
- **`/purchases/vendors` (legacy)** is a filtered `<Contacts defaultTypeFilter="supplier" />` view — a UI alias, not a parallel data model. It shares the Contacts data path entirely.
- **Currency default bug (confirmed)**: `SupplierCreatePage.tsx` uses a literal `placeholder="USD"` and stores the raw input; it does NOT read `businesses.base_currency`. `businesses.base_currency` itself defaults to `'USD'` in the schema — that default is also suspect for non-US tenants but is out of scope for procurement.

The audit categorises findings into:

- **Confirmed issues** (fix in Phase 3): currency inheritance, legacy `/vendors` nav label ambiguity, undocumented dual-key model (`contacts.id` as document key vs `suppliers.id` as lifecycle key).
- **Rejected observations**: "Supplier should extend Contact" (rejected — current split matches Odoo/SAP: party vs role); "AP defaults on Contact are wrong" (rejected — Contact is the canonical party per ADR-0038, Finance already depends on them).
- **Migration risks**: any code that assumes a `contacts` row is deletable when a `suppliers` row exists; Studio custom fields today attach to `contacts` (verify via `entity_field_configs.entity_type`) — retiring `/vendors` must not orphan them.
- **Architectural debt**: two flows to reach the same supplier record (Contacts app + Purchases → Suppliers); localisation-driven WHT is per-country but stored per-contact as a flat numeric — flag for a future localisation batch.
- **Recommended future work**: Studio-driven Supplier form; per-tenant AP account templates; WHT sourced from `localization_packs` instead of `contacts.withholding_tax_rate`.

## Phase 3 — Small hardening batches (one per turn, gated by rollback-marker smokes)

Only the small, low-risk fixes surfaced by Phase 2. Each batch keeps the discipline used through Batch H (single migration, canonical writer test extension, `__SMOKE_ROLLBACK_MARKER__` smoke).

- **H+1 Currency inheritance**: `SupplierCreatePage` and `ContactRecordForm` (vendor-role branch) read `currentBusiness.base_currency` as the default; input remains editable. Frontend-only, no migration. Add unit test.
- **H+2 Legacy alias clarity**: rename the `/purchases/vendors` label to `"Suppliers (contact view)"`, add a top-of-page banner linking to `/purchases/suppliers`. Do NOT delete the route — it is the only way today to reach vendor-only Contact fields (AP defaults, WHT).
- **H+3 Documented dual-key ADR**: add `docs/adr/0079-procurement-party-vs-role.md` locking in "documents key off `contacts.id`, lifecycle keys off `suppliers.id`, join via `suppliers.contact_id`".
- **H+4 Studio field inventory**: read-only query of `entity_field_configs` grouped by `entity_type`, appended to the audit. No migration.

## Phase 4 — Legacy Vendor retirement strategy (planning only, no code)

Extend `.lovable/plan.md` with an explicit retirement plan for the `/purchases/vendors` route. Blocked until every item below has a documented owner and successor:

| Dependency | Evidence to gather | Retirement path |
| --- | --- | --- |
| AP defaults edit UI | `rg "default_payable_account_id\|withholding_tax_rate" src/` | Migrate the edit surface into Supplier record page's "Finance defaults" section, still writing to `contacts` |
| Vendor Statements report | `src/pages/VendorStatements.tsx` | Confirm it reads via `contacts`; no change needed |
| Bill / PO / RFQ vendor pickers | listed files above | Keep querying `contacts` filtered by `supplier_rank>0`; Supplier existence is not required to raise a bill (audit note) |
| Studio custom fields | `entity_field_configs.entity_type='contact'` | Preserved; no migration |
| Imports / exports | `bulk_operation_runs` targets | Keep contact-shaped payload; add optional supplier lifecycle fields as a second pass |
| Portal invitations | `vendor_portal_invitations` | Key off `contacts.id`; unaffected |

Route deletion happens only after Supplier record page absorbs the AP-defaults editor (H+1 through H+4 land first). This is queued as **Batch K-Retire**, not implemented in this plan.

## Phase 5 — Playwright & RLS re-audit (Batches L & M from prior plan, unchanged)

Retained from the inherited plan. Batch L Playwright now includes:

- The `guard_bill_self_approval` cast regression from H-Verify.
- Currency-inheritance assertion (Phase 3 H+1).
- A guard that `/purchases/vendors` still renders while Supplier-defaults editor is not yet migrated.

Batch M publishes `docs/audit/procurement-verdict.md` consolidating: Phase 1 verification, Phase 2 audit, Phase 3 outcomes, Phase 4 retirement queue, Phase 5 test coverage.

## Phase 6 — Repair queue (contingent)

Any FAIL from Phase 1 becomes a repair batch here, gated by its own smoke, before Batch M publishes.

## Technical details

- Read-only exploration uses `supabase--read_query` and `rg`; no migrations in Phases 1–2, 4, 5-planning.
- Phase 3 batches follow the existing table-migration contract: `CREATE → GRANT → RLS → POLICY` where applicable, `SECURITY DEFINER` + `SET search_path=public` for any new RPC, outbox emission with `<event>:<entity>:<state>` idempotency, canonical-writer guard extension.
- No edits to `src/routeTree.gen.ts` or `src/integrations/supabase/types.ts`.
- The audit deliverables live under `docs/audit/` and `docs/adr/`; execution logs live in `.lovable/plan.md`.

## Deliverables at end of this plan

1. `.lovable/plan.md` rewritten to reflect the hardening milestone, with Phase 1 verification log appended.
2. `docs/audit/procurement-vendor-vs-supplier.md` — evidence-backed audit answering every user observation with a confirmed / rejected / deferred verdict.
3. `docs/adr/0079-procurement-party-vs-role.md` — locks in dual-key model.
4. Small hardening batches H+1 … H+4 landed one-per-turn with rollback-marker smokes where DB changes exist.
5. Legacy `/purchases/vendors` retirement queued as **Batch K-Retire**, blocked until Supplier record page absorbs the AP-defaults editor.
6. Batch L Playwright + Batch M `docs/audit/procurement-verdict.md` closing the hardening phase.
