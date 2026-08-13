# Procurement Contracts — Verification Verdict (2026-08-13) and Remaining Roadmap

Roadmap of record: `.lovable/plan/procurement-contracts-audit-findings-reconstruction-roadmap-2026-08-13.md`.
This file supersedes the previous engineer's status section with independently verified findings.

## 1. Verification verdict on claimed work

Checked directly against the live database and the code, not against the prior notes.

Confirmed as genuinely in place:

- Lifecycle guard and RPC-only writes. `trg_pc_status_guard` and `trg_pc_currency_guard` exist on `procurement_contracts`; the five contract tables carry **read-only** RLS for `authenticated` (SELECT policies only, no INSERT/UPDATE/DELETE policies), so all mutation must pass through the eight SECURITY DEFINER RPCs (`create_`, `submit_`, `activate_`, `amend_`, `renew_`, `terminate_`, `set_..._state`, `..._sweep_expiries`).
- Currency and UOM columns: `currency`, `base_currency`, `exchange_rate`, `exchange_rate_date` on the header; `trg_pc_line_normalize` on lines.
- Utilization ledger and staging triggers exist: `trg_goods_receipt_contract_stage`, `trg_bill_item_contract_stage`, `trg_bill_payment_contract_stage`, `trg_purchase_order_contract_reversal`.
- PO enforcement trigger `trg_purchase_order_contract_ceiling` exists and, per the migration, also stamps `purchase_orders.contract_version` / `contract_snapshot` — so the snapshot **write** side of Phase 9 is real.
- Event topics registered: seven `procurement.contract.*` prefixes.
- PO create page wires supplier contracts, contract line coverage and negotiated price, and writes `contract_id` / `contract_line_id`.

Failed or overstated claims:

1. **Phase 5 is not partially done, it is broken.** `submit_procurement_contract` calls `approval_route('procurement_contract.activate', ...)` but wraps it in `EXCEPTION WHEN OTHERS THEN v_req := NULL`, so a policy failure is silently swallowed. There is **no mirror trigger** on `approval_requests` for `entity_type = 'procurement_contract'` (the table has mirrors for expense, purchase_return, requisition, rfq, vendor_credit_note only). A governance approval therefore never activates the contract, and `activate_procurement_contract` still hand-rolls its own creator≠approver check and can be called while a live request is open. Governance is decorative today.
2. **FX inside activation violates ADR-0136.** `activate_procurement_contract` reads `public.exchange_rates` with a hand-rolled `ORDER BY effective_date DESC LIMIT 1` instead of `resolve_exchange_rate` / `require_exchange_rate`, ignores `source` precedence, has no inverse-pair handling, and stores `NULL` silently when no rate exists — a second FX lookup path, exactly what the ADR forbids.
3. **Phase 9 read side is absent.** No code anywhere reads `contract_snapshot`, `contract_version` or `contract_unit_price`. The PO record page shows no contract terms as-of issuance.
4. **Phase 8 is not complete.** Requisition screens never surface or write `contract_line_id`, requisition → PO conversion drops it, Supplier 360 contract tab has no utilization, and PO lines give no remaining-capacity feedback.
5. **Nothing is exercised.** Zero rows in `procurement_contracts`, `procurement_contract_releases`, and zero POs with a `contract_id`. Every trigger path above is unproven at runtime; no tests exist for the domain (Phase 12 untouched).
6. **Phase 11 untouched.** Contract list is a plain table with no KPIs or lifecycle filters.

Verdict: the structural spine (Phases 1–4, 6, 7, 10) is real; governance, FX-in-activation, snapshot consumption, consumer wiring, workspace UI and all verification are outstanding.

## 2. Remaining roadmap, in dependency order

### Phase A — Repair activation governance (was Phase 5)
- Confirm/insert the `procurement_contract.activate` key in `governance_action_registry`.
- Remove the swallow-all around `approval_route`; a policy error must fail the submit.
- Add `_mirror_approval_to_procurement_contract()` + AFTER UPDATE trigger on `approval_requests` filtered to `entity_type = 'procurement_contract'`: approved → activate, rejected/cancelled → back to draft.
- `activate_procurement_contract` becomes the ungated fallback: refuse with `ERRCODE 42501`, `HINT = 'GOV_USE_APPROVAL_ENGINE'` while a live request exists; keep the creator≠approver backstop.

### Phase B — Fold activation FX into the one engine
- Replace the inline `exchange_rates` query with `require_exchange_rate` (or `resolve_exchange_rate` plus an explicit "no rate on file" failure). Never store a silent `NULL`/1 rate.
- Contract display surfaces render `—` when no rate resolves.

### Phase C — Prove the spine works (moved ahead of new UI)
Runtime verification of already-built triggers before more consumers depend on them:
- lifecycle: illegal transitions rejected;
- enforcement: wrong currency, out-of-window contract, over-tolerance price, uncovered item, quantity and value ceiling breach;
- ledger nets to zero after PO approve → cancel; receipt/bill/payment stages post exactly once;
- concurrency: two simultaneous POs cannot jointly exceed one ceiling (`FOR UPDATE` path).
Any defect found here is fixed inside this phase.

### Phase D — Snapshot consumption (Phase 9 read side)
- PO record page renders "Terms as of issuance" from `contract_snapshot` / `contract_version` / line `contract_unit_price`, not a live join.
- Amendment history links the version a PO was issued under.

### Phase E — Finish the consumers (Phase 8 remainder)
- Requisition line contract reference: surface and write `contract_line_id`; carry it through requisition → PO conversion.
- Supplier 360 contract tab: per-contract committed / received / billed / paid / remaining and expiry state.
- PO line-level remaining quantity and value with an over-ceiling warning before submit.

### Phase F — Contracts workspace (Phase 11)
KPIs bound to real states: active, pending approval, expiring 30/60/90, ≥90% exhausted, off-contract leakage; filters by state, supplier, expiry; per-row utilization.

### Phase G — Test suite (Phase 12)
Domain lifecycle, enforcement, concurrency, FX, UoM, amendment as-of resolution, plus architecture guards: no direct browser writes to contract tables, no second approval/FX/UOM engine, no legacy contract route.

## 3. Standing architectural rules
Contracts make no GL postings. No second FX, UOM, approval or event engine. All writes through SECURITY DEFINER RPCs. `supplier_item_terms` / price lists own standing pricing; a cited contract takes precedence at PO time.
