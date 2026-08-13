# Procurement Contracts — Audit Findings & Reconstruction Roadmap

## 1. What exists today (verified, not assumed)

The domain is real and better than the UI suggests, but it is a partially wired skeleton.

Verified in the database:

- `procurement_contracts` (24 cols): supplier, number, kind, status, `currency text default 'USD'`, start/end date, `ceiling_value`, `utilized_value`, `auto_renew`, approver fields.
- `procurement_contract_lines` (15 cols): product, description, `uom_id`, unit price, min/max/ceiling quantity, ceiling value, `utilized_quantity`, `utilized_value`.
- `procurement_contract_releases` (10 cols): a real consumption ledger keyed to `purchase_order_id` + `purchase_order_item_id`.
- Lifecycle RPCs, all SECURITY DEFINER: `create_procurement_contract`, `activate_procurement_contract`, `amend_procurement_contract`, `terminate_procurement_contract`, `procurement_contracts_sweep_expiries`.
- Trigger `trg_purchase_order_contract_ceiling` on `purchase_orders` (enabled): on transition into `approved` it locks the contract `FOR UPDATE`, rejects non-active/expired/wrong-business/wrong-supplier contracts, enforces header and line ceilings, writes releases, and increments utilization.
- Outbox events emitted: `procurement.contract.created`, `.activated`, `.expired`, `.ceiling_breached_attempt`.
- FK columns already present: `purchase_orders.contract_id`, `purchase_order_items.contract_line_id`, `purchase_requisition_items.contract_line_id`.
- All four contract tables contain **zero rows**. No production data to protect — cleanup and schema change are free.

Verified in code: `src/features/purchases/contracts/` (list, create, record, `useContracts.ts`, `contractRpcs.ts`), routed from `src/apps/purchases/routes.tsx`, nav entry in `src/apps/purchases/nav.ts`. Writes are RPC-only; reads are direct selects. No duplicate or legacy procurement-contract implementation exists (HR `employee_contracts` is a separate, unrelated domain and stays).

## 2. Confirmed defects (each has evidence above)

1. **The control is unreachable from the UI.** No PO, requisition, RFQ, bill or goods-receipt screen exposes a contract selector or writes `contract_id` / `contract_line_id`. `createPurchaseOrder` in `src/hooks/usePurchaseOrders.ts` never sets them. The ceiling trigger therefore never fires in practice — the enforcement engine is real but orphaned.
2. **RLS lets the browser bypass every RPC.** `procurement_contracts_write` is `FOR ALL` to any user with business access, so a client can `update` status, `ceiling_value`, or `utilized_value` directly. The RPC discipline is convention only. Purchasing peers already use the stricter v2 pattern (`user_can_access_business` + `user_can_access_branch` + `user_has_module_permission('purchases', …)`).
3. **Currency is free text and FX-blind.** `currency text default 'USD'`, no `exchange_rate`, no validation against `business_active_currencies`. The ERP has a canonical stack (`currencies`, `exchange_rates`, `business_active_currencies`, `CurrencyContext`, `<CurrencySelect>`) and a guard-trigger precedent. A PO in a different currency can consume a contract ceiling with no translation at all.
4. **Utilization stops at PO approval.** Contracted / committed / ordered / received / billed / paid are collapsed into one `utilized_value`. Nothing decrements on PO cancellation, revision, or partial receipt, so a cancelled PO permanently burns ceiling.
5. **No price enforcement.** Negotiated `unit_price` on a contract line is decorative; a PO line may use any price.
6. **No amendment history or effective-dated terms.** `amend_procurement_contract` mutates the active row in place. `contract_amendments` belongs to HR, not procurement. An auditor cannot answer "what terms were active when this PO was issued".
7. **No snapshotting.** POs join live contract/supplier data; historical truth is not preserved.
8. **Approvals are ad hoc.** `activate_procurement_contract` hand-rolls a creator≠approver check instead of using the canonical `approval_route()` / `approval_requests` engine that RFQs and requisitions use.
9. **Status is a text column, not a state machine.** No enum, no transition table, no guard on illegal transitions.
10. **UOM is inert.** Lines carry `uom_id` but no conversion to the product's reference UoM via `convert_uom()`, so a "10,000 boxes" ceiling cannot be reconciled against receipts in eaches.

Boundary decision (resolves the Contract vs Supplier Terms overlap): `supplier_item_terms` and `price_lists` own standing, non-committal supplier pricing; a procurement contract owns *committed, time-boxed, ceiling-bearing* terms and takes precedence when a document cites it. Both tables are empty, so no migration of live data is required.

## 3. Roadmap (dependency-ordered)

**Phase 1 — Lock the boundary.** Replace `FOR ALL` RLS with v2-pattern read policies plus deny-by-default writes; all mutation moves through SECURITY DEFINER RPCs. Add `status` enum + transition guard trigger (`draft → pending_approval → active → suspended/expired/terminated/closed`).

**Phase 2 — Canonical currency & FX.** FK currency to `currencies`, guard against `business_active_currencies`, add `exchange_rate` + rate date stamped at activation, and define ceiling semantics: contract currency is authoritative, base-currency figures are derived for reporting. Replace the free-text input with `<CurrencySelect>`.

**Phase 3 — Canonical UOM.** Contract line quantities normalize to the product reference UoM via `convert_uom()`; store both contract UoM and base quantity. No contract-local conversion logic.

**Phase 4 — Versioning & effective-dated amendments.** New `procurement_contract_versions` + `procurement_contract_amendments`. Amendments create a new version; the active row points to the current version. Add a resolver returning terms as-of a date.

**Phase 5 — Approval engine reuse.** Retire the inline SoD check; route activation through `approval_route()` with a `procurement_contract.activate` action key and an `approval_request_id` column, matching the RFQ pattern.

**Phase 6 — Utilization model.** Split into distinct measures — contracted, committed (approved POs), received (GRN), billed, paid, remaining. Releases become the single append-only source; header/line counters become derived views. Add reversal entries on PO cancel/revise so ceiling is returned.

**Phase 7 — Enforcement at consumption points.** Extend the ceiling trigger with price enforcement (tolerance policy) and item-coverage checks; enforce currency match between PO and contract; wire the same checks for requisition → PO conversion. Keep the existing `FOR UPDATE` locking, which is already correct for concurrency.

**Phase 8 — Wire the UI consumers.** Contract selector on PO create/edit, line-level contract-line picker with price/UoM/ceiling prefill and remaining-capacity display; requisition line contract reference; contract tab on Supplier 360 (already read-only, extend with utilization).

**Phase 9 — Snapshots.** POs persist the contract version id, agreed price, currency, FX rate, payment terms and incoterms at issuance, so documents stay explainable after amendments.

**Phase 10 — Event taxonomy completion.** Add `.submitted`, `.amended`, `.suspended`, `.terminated`, `.renewed`, `.utilization_changed` through the existing outbox helper and register the `procurement.contract.` prefix in `business_event_topics`. No new event system.

**Phase 11 — Workspace UI.** Rebuild list page as an operational workspace: KPIs (active, pending approval, expiring in 30/60/90 days, exhausted ≥90% ceiling, leakage — off-contract spend with a contracted supplier), filters by state/supplier/expiry, per-row utilization bars. Record page: terms, coverage, utilization waterfall, releases, amendment history, approval trail.

**Phase 12 — Tests.** Lifecycle transitions (valid and invalid), ceiling and price enforcement, concurrent PO consumption against one ceiling, cancellation reversal, currency/FX correctness, UoM conversion, amendment as-of resolution, and architecture guards (no direct browser writes, no second FX/UOM/approval/event engine).

## 4. Notes

- Finance boundary: a contract is a commercial commitment, not an accounting transaction. No GL postings from contracts. Commitment/encumbrance reporting is derived from releases; only PO → GRN → Bill → Payment post to the ledger.
- Inventory boundary: contracts publish obligations and expected supply; Inventory/Warehouse keep sole ownership of physical stock state.
- Phases 1–3 are prerequisites for everything else; 4 precedes 9; 6 precedes 7. Each phase ends in a working state.
