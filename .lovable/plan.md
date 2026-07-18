
# Enterprise Procurement (P2P) — Verification & Continuation Plan

> **Living status doc.** Update every batch. Companion detail log: `.lovable/procurement-domain-audit.md`.

## Status snapshot (2026-07-18)

| Phase | Scope | Backend | UI | E2E | State |
| --- | --- | --- | --- | --- | --- |
| P0 | Foundation — event fabric, canonical GR wrapper, split of stock/finance from procurement, arch guard | ✅ | n/a | pending (P12) | **shipped** |
| P1 | Supplier Master schema + lifecycle RPCs | ✅ | ❌ | pending (P12) | backend shipped; UI pending |
| P2 | Contracts, ceiling enforcement, releases, expiry sweep | ✅ | ❌ | pending (P12) | backend shipped; UI pending |
| P3 | Requisitions + approvals chain, PO back-links | ✅ | ❌ | pending (P12) | backend shipped; UI pending |
| P4 | Sourcing supertype (`sourcing_events`, scoring, sealed bid) | ❌ | ❌ | — | not started |
| P5 | PO lifecycle: revisions, acks, change orders, line state machine | ❌ | ❌ | — | not started |
| P6 | ASN (`inbound_shipments` promoted) | ❌ | ❌ | — | not started |
| P7 | GR reconstruction: `receipt_deliveries`, multi-delivery, backorders, QC | ❌ | ❌ | — | not started |
| P8 | Match engine: `bill_match_results`, tolerance policy, AP exception queue | ❌ | ❌ | — | not started |
| P9 | Returns + vendor credit chain end-to-end | ❌ | ❌ | — | not started |
| P10 | Supplier scorecards + KPI snapshots from outbox | ❌ | ❌ | — | not started |
| P11 | Workbench UX (Buyer / Receiver / AP / Supplier 360) + retire legacy CRUD | ❌ | ❌ | — | not started |
| P12 | Playwright `procurement` project — full E2E harness | ❌ | n/a | — | not started |
| P13 | RLS + governance re-audit; SoD conflicts; vendor portal scope | ❌ | n/a | — | not started |

## What shipped so far

### P0 — Foundation & Great Split (2026-07-18)
- `business_event_topics` registry + `business_event_subscriptions` registry seeded.
- Canonical `create_goods_receipt(_business_id, _po_id, _lines, _actor, _warehouse_id?, _receipt_number?, _receipt_date?)`.
- `complete_goods_receipt_atomic` reconstructed — no direct writes to `stock_movements`, `stock_quants`, `cost_layers`, `journal_entries`, `journal_entry_lines`. Now orchestrates `wms_apply_gr_stock` → `finance_post_gr_journal` → mark completed → emit `procurement.gr.posted`.
- `v_po_line_billed_progress` reconciliation view (`security_invoker=true`).
- Commit-time SQL invariant blocks forbidden-table references from ever regressing.
- Architecture guard `src/test/architecture/procurement.test.ts`.

### P1 — Supplier Master (backend)
- Tables: `supplier_categories`, `suppliers`, `supplier_qualifications`, `supplier_qualification_documents`, `supplier_compliance_checks`, `supplier_bank_accounts`, `approved_supplier_list`.
- Idempotent backfill from vendor-typed `contacts`.
- Lifecycle RPCs: `submit_supplier_qualification`, `approve_supplier_qualification`, `reject_supplier_qualification`, `suspend_supplier`, `reinstate_supplier` — all outbox-emitting.
- Runtime verification folded into P12 (RPCs require `auth.uid()`).

### P2 — Contracts & Agreements (backend, 2026-07-18)
- Tables: `procurement_contracts`, `procurement_contract_lines`, `procurement_contract_releases`.
- PO linkage: `purchase_orders.contract_id`, `purchase_order_items.contract_line_id`.
- Trigger `tg_purchase_order_contract_ceiling` on `BEFORE UPDATE OF status`: enforces contract status/expiry/supplier match/header + line ceilings on PO approval, writes releases, bumps utilization atomically. Failed attempts emit `procurement.contract.ceiling_breached_attempt`.
- RPCs: `create_procurement_contract`, `activate_procurement_contract` (self-approval blocked), `terminate_procurement_contract`, `amend_procurement_contract`.
- `procurement_contracts_sweep_expiries()` for scheduled expiry marking.
- Topics: `procurement.contract.{created,activated,terminated,expired,amended,release_recorded,ceiling_breached_attempt}`.

### P3 — Purchase Requisitions (backend, 2026-07-18)
- Tables: `purchase_requisitions`, `purchase_requisition_items` (generated `estimated_line_total`), `purchase_requisition_approvals` (audit chain).
- PO back-links: `purchase_orders.requisition_id`, `purchase_order_items.requisition_item_id`.
- Lifecycle RPCs: `submit_requisition`, `approve_requisition` (approver ≠ requester), `reject_requisition`, `cancel_requisition`.
- Topics: `procurement.requisition.{submitted,approved,rejected,cancelled}`.

## Next batch — pick up here

**Verify first (agent should re-run these before writing code):**
1. Regenerated `src/integrations/supabase/types.ts` includes `procurement_contracts`, `procurement_contract_lines`, `procurement_contract_releases`, `purchase_requisitions`, `purchase_requisition_items`, `purchase_requisition_approvals`, and the new columns on `purchase_orders` / `purchase_order_items`. If not, wait for the types regen before proceeding.
2. `src/test/architecture/procurement.test.ts` still passes (no forbidden-table refs slipped in).
3. Registry rows exist for every `procurement.contract.*` and `procurement.requisition.*` topic:
   ```sql
   select topic_prefix from public.business_event_topics
    where topic_prefix like 'procurement.contract.%'
       or topic_prefix like 'procurement.requisition.%'
    order by topic_prefix;
   ```

**Then implement, in this order (do not skip ahead — each unlocks the next):**

**Batch N+1 — UI catch-up for shipped backends**
1. **Supplier 360 workbench** (P1-UI) at `src/apps/purchases/pages/suppliers/` — list + record page. Record tabs: Identity, Qualification timeline (reads `supplier_qualifications` + `_documents`), Compliance, Bank accounts, Contracts (reads P2), Requisitions (reads P3), PO/GR/Bill/Payment history, Scorecard (empty placeholder until P10). Wire actions to the 5 supplier RPCs. Add route + nav entry under "Vendors".
2. **Contracts workbench** (P2-UI) at `src/apps/purchases/pages/contracts/` — list + record. Record shows header, lines with utilization bars (`utilized_value / ceiling_value`), releases ledger table (from `procurement_contract_releases`), status transitions calling the 4 contract RPCs. Add nav entry under "Setup" or "Vendors".
3. **Requisition workbench** (P3-UI) at `src/apps/purchases/pages/requisitions/` — requester "New requisition" form (lines with product/qty/estimated price/need-by/suggested supplier), submit → approve → reject flow, buyer inbox filtered to `status='approved'` awaiting sourcing. Wire the 4 requisition RPCs.

**Batch N+2 — P4 Sourcing supertype**
- `sourcing_events { kind: rfi|rfq|rfp|auction }`, `sourcing_scoring_criteria`, `sourcing_vendor_scores`, sealed-bid `opens_at`, award justification.
- Extend existing `rfqs` non-destructively (add `sourcing_event_id` FK).
- New RPC `award_sourcing_event_atomic` — respects contract ceilings (calls the P2 machinery) and stamps `purchase_orders.requisition_id` when the RFQ was seeded from a requisition. Emits `sourcing.event.*` events.

**Batch N+3 — P5 PO lifecycle**
- `purchase_order_revisions`, `purchase_order_acknowledgements`, `purchase_order_change_orders`.
- Add `state` enum on `purchase_order_items` (`draft|issued|acknowledged|partially_received|received|closed|cancelled`).
- RPCs: `issue_purchase_order`, `acknowledge_purchase_order`, `create_po_change_order`, `close_po_line`, `cancel_po_line`. Vendor portal ack UI.

**Batch N+4 onward — P6 → P13** in the order listed in the Status Snapshot. No phase closes until its E2E spec (part of P12) is unskipped and asserts read-back + outbox rows.

## Phase 1 — Verification results (evidence-backed, historical)

Verified against `pg_proc`, `information_schema`, and live tables in the connected DB (not just the previous engineer's log).

### P1 Supplier Master — ✅ structurally shipped

- **Tables present**: `suppliers`, `supplier_categories`, `supplier_qualifications`, `supplier_qualification_documents`, `supplier_compliance_checks`, `supplier_bank_accounts`, `approved_supplier_list` — all 7 confirmed in `information_schema.tables`.
- **Lifecycle RPCs present**: `submit_supplier_qualification`, `approve_supplier_qualification`, `reject_supplier_qualification`, `suspend_supplier`, `reinstate_supplier` — all 5 confirmed in `pg_proc`, and each function body references `business_event_outbox` (i.e. they do emit `supplier.*` events on paper).
- **Runtime exercise**: `suppliers` has **0 rows**, `contacts WHERE type IN ('supplier','both')` returns **0 rows**, `business_event_outbox WHERE event_type LIKE 'supplier.%'` returns **0 rows**. The backfill was a no-op (no vendor-typed contacts existed), and no RPC has ever been called in this environment. The plan's claim "backfill covered all vendor-typed contacts" is trivially true but not evidence of correctness. **Outbox emission is verified by code inspection, not by observed events.** Runtime verification is folded into P12 (E2E harness).
- **UI**: no Supplier 360 workbench exists yet — plan already marks P1-UI pending.

### P0 Foundation & drift removal — ✅ shipped (2026-07-18)

- `public.business_event_topics` registry table + `supplier.*` / `procurement.*` / `sourcing.*` seed rows.
- `public.business_event_subscriptions` registry table; `procurement.gr.posted` bound to `wms.gr_stock_applier` (`wms_apply_gr_stock`) and `finance.gr_journal_poster` (`finance_post_gr_journal`).
- `create_goods_receipt(_business_id, _po_id, _lines, _actor, _warehouse_id?, _receipt_number?, _receipt_date?)` — canonical entry point used by both Procurement UI and WMS receive path.
- `complete_goods_receipt_atomic` **reconstructed**. Body no longer references `stock_movements`, `stock_quants`, `cost_layers`, `journal_entries`, `journal_entry_lines`. It orchestrates: `wms_apply_gr_stock` → `finance_post_gr_journal` → mark completed → emit `procurement.gr.posted` (single emitter, idempotency-keyed).
- `v_po_line_billed_progress` view (with `security_invoker=true`) reconciling `bill_grn_matches.matched_quantity` + direct `bill_items.purchase_order_item_id` against stored `quantity_billed`, exposing `billed_drift` per line.
- Commit-time SQL invariant in the split migration RAISEs if `complete_goods_receipt_atomic` ever regains a forbidden table reference.
- `src/test/architecture/procurement.test.ts` guard test verifies the topic registry, subscription registry, subscribers, canonical wrapper, and reconciliation view all remain declared.

### Everything else (P2 → P13) — ❌ not started

Verified absent in DB: `purchase_requisitions`, `procurement_contracts`, `procurement_contract_lines`, `purchase_order_revisions`, `purchase_order_acknowledgements`, `bill_match_results`, `supplier_scorecards`. Plan claims match reality.

## Phase 2 — Plan validation

The existing plan (`.lovable/plan.md` §§1–7) is architecturally sound and I am **adopting it as-is** with the following minor amendments proven by verification:

- **P1 closure test**: before P1 is declared "shipped", add a one-shot smoke migration that exercises `submit_supplier_qualification` → `approve_supplier_qualification` on a seed row and asserts one `supplier.qualification_submitted` and one `supplier.qualification_approved` row appear in `business_event_outbox`. This gives real runtime evidence, not just code inspection.
- **P0 addition — outbox topic registry**: `business_event_outbox` currently uses free-form `event_type`. Before P2 downstream consumers subscribe, add a `business_event_topics` registry row per prefix (`supplier.*`, `procurement.*`, `sourcing.*`) with a `producer_domain` + `consumer_domains[]` column. Keeps the fabric self-documenting.
- **P0 addition — canonical stock-write wrapper naming**: the WMS side already has `create_goods_receipt` reserved. Introduce `procurement_emit_gr_received(_gr_id)` as the Procurement-side emitter and `wms_apply_gr_stock(_event_id)` as the Inventory subscriber, so the split is clear in `pg_proc`.
- **P7 amendment**: `goods_receipts` header stays, but add `receipt_deliveries` (many receipts per PO), preserving the header FK on legacy data. Backfill each existing `goods_receipts` row as a single `receipt_deliveries` row.
- **P8 amendment**: 4-way match must also cite `wms_qc_inspections` outcomes, not only GR quantity; `bill_match_results.qc_inspection_id` nullable FK.
- **P11 amendment**: retire the CRUD "record" pages *only after* the workbench replaces them, and only after `e2e/procurement/*` covers the same flows — no dark-cutover.

Nothing in the plan is dropped.

## Phase 3 — Execution order (pickup)

Strict chronological order. Each phase closes only when its migration lands **and** the corresponding E2E spec (in P12 harness) is unskipped and asserts read-back + outbox rows.

### Next batch — P1-UI (Supplier 360) + P2 (Contracts)

P0 is closed. P1 runtime verification (submit → approve → outbox rows) folds into the P12 E2E harness — a migration-time smoke is impossible because the supplier RPCs check `auth.uid()`. The next batch is:

1. **P1-UI** — Supplier 360 workbench: identity, qualification timeline, compliance docs, contracts, price lists, PO/GR/Bill/Payment history, scorecard tab (empty until P10).
2. **P2** — Contracts & Agreements (`procurement_contracts`, `_lines`, `_releases`; ceiling enforcement at PO approval; expiry outbox alerts; contracts workbench).

### Subsequent phases (unchanged from `.lovable/plan.md`)

- **P1-UI** — Supplier 360 workbench: identity, qualification timeline, compliance docs, contracts, price lists, PO/GR/Bill/Payment history, scorecard tab (empty until P10).
- **P2** — Contracts & Agreements (`procurement_contracts`, `_lines`, `_releases`; ceiling enforcement at PO approval; expiry outbox alerts; contracts workbench).
- **P3** — Requisitions (`purchase_requisitions`, items, approvals reusing `approval_requests` with procurement policy; category routing; budget hook; PR→RFQ and PR→PO converters; `procurement.requisition.*` events; requester form + buyer inbox).
- **P4** — Sourcing supertype (`sourcing_events { kind: rfi|rfq|rfp|auction }`, `sourcing_scoring_criteria`, `sourcing_vendor_scores`, sealed-bid open time, award justification; extend existing `rfqs` non-destructively).
- **P5** — PO lifecycle (`purchase_order_revisions`, `_acknowledgements`, `_change_orders`; `purchase_order_items.state` enum; RPCs `issue_purchase_order`, `acknowledge_purchase_order`, `create_po_change_order`, `close_po_line`, `cancel_po_line`; vendor portal ack UI).
- **P6** — ASN: promote `inbound_shipments` to expected-delivery object; bind to PO lines; drive `wms_dock_appointments`; `procurement.inbound.*` events.
- **P7** — GR reconstruction: `receipt_deliveries` (many per PO); over/under/damaged/rejected fields; substitution capture; pallet/carton/unit hierarchy via `wms_license_plates`; wire `backorders` on short receipt; QC integration; `procurement.gr.*` events per line.
- **P8** — Match: `bill_match_results` (per bill line, PO line, GR line, optional QC), `procurement_match_tolerance_policies`; 2-/3-/4-way; AP exception queue.
- **P9** — Returns to supplier & vendor credit chain formalised end-to-end.
- **P10** — Supplier performance: `supplier_scorecards`, `supplier_kpi_snapshots`, nightly aggregation from `business_event_outbox`; feeds `approved_supplier_list.rank`.
- **P11** — Workbench UX (Buyer / Receiver / AP / Supplier 360), retire CRUD record pages behind flag once workbench covers the flow.
- **P12** — Playwright project `procurement`: `requisition`, `sourcing`, `contract-release`, `po-lifecycle`, `receive-multi`, `qc-integration`, `match`, `return-credit`, `performance`. Architecture guard forbids `describe.skip`.
- **P13** — RLS + governance re-audit; `governance_sod_conflicts` entries for requester ≠ approver ≠ buyer ≠ receiver ≠ AP; vendor portal scope re-audit.

## Guardrails (held every phase)

- Procurement code never writes to `stock_quants`, `stock_movements`, `cost_layers`, `journal_entries`, `journal_entry_lines` — enforced by `procurement.test.ts` (P0 step 6).
- Every new `public.*` table: `CREATE TABLE` → `GRANT` → `ENABLE RLS` → `CREATE POLICY` in the **same** migration; `authenticated` gets DML, `service_role` gets ALL, `anon` denied.
- Every lifecycle RPC: `SECURITY DEFINER`, `SET search_path = public`, business-scoped via `user_has_business_access(auth.uid(), business_id)`, atomic, self-approval blocked, outbox emit with idempotency key `<topic>:<entity_id>:<state>`.
- No phase closes until its E2E spec is unskipped and asserts read-back state + outbox rows (WMS Phase 14 standard).
- No destructive drops until the workbench replaces the CRUD page for that entity.

## Out of scope

- POS-side receiving (WMS mobile owns).
- Manufacturing procurement of components.
- Multi-entity intercompany PO — deferred pending entity-model decisions.

---

**Deliverable of the next build batch:** UI catch-up (Supplier 360, Contracts, Requisitions workbenches) wired to shipped RPCs. Once verified, resume backend chronology with P4 Sourcing.
