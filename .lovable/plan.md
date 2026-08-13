# Procurement Contracts — Authoritative Project Status (2026-08-13)

Roadmap of record: `.lovable/plan/procurement-contracts-audit-findings-reconstruction-roadmap-2026-08-13.md` (12 phases).
This file tracks execution against it. Phase numbering below is that roadmap's numbering.

## 1. Completed and verified

**Phase 1 — Boundary locked.** `procurement_contract_status` enum in place; `trg_pc_status_guard` enforces legal transitions; `FOR ALL` RLS replaced with read policies plus deny-by-default writes on `procurement_contracts`, `_lines`, `_releases`, `_versions`, `_amendments`. All mutation runs through SECURITY DEFINER RPCs: `create_`, `submit_`, `activate_`, `amend_`, `renew_`, `terminate_`, `set_procurement_contract_state`, `procurement_contracts_sweep_expiries`.

**Phase 2 — Currency & FX.** `currency` FK'd to canonical `currencies`; `trg_pc_currency_guard` validates against `business_active_currencies`; `base_currency`, `exchange_rate`, `exchange_rate_date` stored. Create form uses `CurrencyContext` currencies, not free text.

**Phase 3 — UOM.** `base_uom_id` + `ceiling_quantity_base` on lines; `trg_pc_line_normalize` normalizes via canonical `convert_uom()`. No contract-local conversion logic.

**Phase 4 — Versioning & amendments.** `procurement_contract_versions` and `procurement_contract_amendments` created; amendments cut a new version; record page renders version and amendment history.

**Phase 6 — Utilization model.** `procurement_contract_releases` rebuilt as a signed append-only ledger with `entry_kind` in (commitment, reversal, receipt, billing, payment). Stage triggers post progress: `trg_goods_receipt_contract_stage`, `trg_bill_item_contract_stage`, `trg_bill_payment_contract_stage`, plus `trg_purchase_order_contract_reversal` returning ceiling on PO cancel/revise.

**Phase 7 — Enforcement.** `trg_purchase_order_contract_ceiling` extended: currency match, contract window, price tolerance (`price_tolerance_percent` / `_amount`), item coverage (`enforce_item_coverage`), quantity and value ceilings, `FOR UPDATE` locking retained, releases written on approval.

**Phase 10 — Event taxonomy.** `procurement.contract.*` prefixes registered in `business_event_topics` (created, activated, amended, terminated, expired, release_recorded, ceiling_breached_attempt).

**Phase 8 (partial) — PO consumer wired.** `useSupplierContracts` hook (active, in-window contracts for the selected vendor, remaining ceiling). Contract selector on PO create and edit; vendor change clears coverage; line product selection captures `contract_line_id` and the negotiated `unit_price` (contract price outranks vendor price list); PO detail shows the contract or "Spot buy". `tsgo --noEmit` clean.

## 2. Currently active phase

**Phase 8 — Wire the UI consumers.** PO create/edit/detail are done. Remaining in this phase:

- Requisition line contract reference in the UI. `purchase_requisition_items.contract_line_id` and the RPC field already exist (`requisitionRpcs.ts:31`, `useRequisitions.ts:178`) but no requisition screen surfaces or writes it, and requisition → PO conversion does not carry it forward.
- Supplier 360 contract tab: currently a read-only list; extend with per-contract utilization (committed / received / billed / paid / remaining) and expiry state.
- Remaining-capacity feedback at line level on POs (per-line remaining quantity/value, over-ceiling warning before submit) — the header selector shows remaining value only.

## 3. Pending work (not started)

- **Phase 5 — Approval engine reuse.** `activate_procurement_contract` still hand-rolls the creator≠approver check; it does not call `approval_route()` and there is no `approval_request_id` column. This is the largest remaining architectural deviation and blocks parity with RFQ/requisition governance.
- **Phase 9 — Snapshots.** `purchase_orders.contract_snapshot` / `contract_version` and `purchase_order_items.contract_unit_price` columns exist, but population at issuance is unverified and nothing reads them. Must be confirmed or completed.
- **Phase 11 — Workspace UI.** Contract list is still a plain table: no KPIs (active, pending approval, expiring 30/60/90, ≥90% exhausted, off-contract leakage), no state/supplier/expiry filters, no per-row utilization bars.
- **Phase 12 — Tests.** No tests exist for this domain: lifecycle transitions, ceiling and price enforcement, concurrent consumption of one ceiling, cancellation reversal, FX correctness, UoM conversion, amendment as-of resolution, architecture guards.

## 4. Next milestone

Finish **Phase 8** (requisition contract reference, Supplier 360 utilization, line-level remaining capacity), then proceed in roadmap order: **Phase 5 → 9 → 11 → 12**. Phase 5 is taken after 8 because the activation path is user-facing and should change once, with the workbench already wired.

## 5. Instructions for the next agent

1. **Verify before building.** Do not trust this file. Confirm against the live database and code:
   - RLS on all five contract tables denies direct browser INSERT/UPDATE/DELETE and grants match the policies.
   - `trg_pc_status_guard` rejects illegal transitions; `trg_purchase_order_contract_ceiling` rejects wrong currency, out-of-window contracts, over-tolerance prices, uncovered items and ceiling breaches.
   - The release ledger nets correctly: approve a PO, cancel it, and confirm committed value returns to zero; receipt/bill/payment stages post exactly once and are not double counted.
   - The PO create/edit contract selector writes `contract_id` and `contract_line_id` end to end and the enforcement trigger sees them.
   Record the verdict at the top of this file before writing new code. Fix any defect found in already-"completed" phases before advancing.
2. **Resume at the next milestone in section 4** — do not pick up unrelated areas of the system.
3. Keep each phase coherent and production-ready before moving on: no orphaned columns, no UI that writes fields nothing enforces, no half-wired workflow.
4. Architectural rules that still hold: contracts make no GL postings; no second FX, UOM, approval or event engine; all writes through SECURITY DEFINER RPCs; `supplier_item_terms` / `price_lists` own standing pricing while a cited contract takes precedence.
5. Update this file as phases close, then archive it when the roadmap is complete.
