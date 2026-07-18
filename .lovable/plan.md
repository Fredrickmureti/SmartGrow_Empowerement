# Enterprise Procurement (P2P) — Architecture Audit & Reconstruction Plan

## 1. What Procurement actually is (first principles)

Procurement is the **enterprise-controlled acquisition of goods, services, and rights from external parties, governed by contracts and executed as an auditable stream of business events that other domains consume.**

It is *not* purchase orders. A PO is one artifact in a broader lifecycle whose canonical shape is:

```text
Need  →  Sourcing  →  Award  →  Commitment  →  Fulfilment  →  Settlement  →  Performance
```

Each stage emits **business events** that are the contract with the rest of the ERP. Warehouse consumes fulfilment events, Inventory consumes movement events, Finance consumes commitment/receipt/invoice/payment events, Analytics consumes performance events. Procurement never mutates stock, never posts GL, never rewrites cost — it *declares intent and state*, and downstream domains react.

Ownership map:

| Concern | Source of truth |
|---|---|
| Supplier identity, qualification, compliance, scorecards | Procurement |
| Contracts, price lists, lead times, incoterms | Procurement |
| Demand (requisition), commitment (PO), settlement (bill) | Procurement |
| Physical receipt task, put-away, QC execution | Warehouse (WMS) |
| Stock quants, lots, serials, valuation layers | Inventory |
| GRNI, AP subledger, GL, payments | Finance |
| Landed cost distribution | Finance (Procurement supplies allocations) |

## 2. Current state — verified

Read against `pg_proc`, migrations, and `src/{apps,features,pages,hooks,components}/purchases`.

**What exists (functional but shallow):**
- Tables: `rfqs / rfq_items / rfq_vendors / rfq_vendor_items`, `purchase_orders / purchase_order_items`, `goods_receipts / goods_receipt_items / goods_receipt_discrepancies`, `bills / bill_items / bill_payments / bill_payment_allocations / bill_grn_matches`, `purchase_returns / purchase_return_items`, `vendor_credit_notes / vendor_credit_note_items / vendor_credit_note_applications`, `vendor_pricelists`, `vendor_portal_invitations`, `landed_cost_bills / landed_cost_allocations`, `inbound_shipments`.
- RPCs: `convert_rfq_to_po_atomic`, `award_rfq_atomic`, `approve_purchase_order`, `complete_goods_receipt_atomic`, `record_goods_receipt_line`, `convert_po_to_bill_atomic`, `confirm_bill_atomic`, `match_bill_to_grn`, `approve_bill`, `approve_bill_payment`, `record_multi_bill_payment`, `apply_vendor_credit_atomic`, `allocate_landed_cost_bill`, `post_landed_cost_bill`, self-approval guards, vendor/business match guards, WMS bridge (`_wms_auto_open_qc_on_grn`, `evaluate_crossdock_on_grn`, `tg_goods_receipt_emit_posted`).
- UI: Record pages + peek sheets for RFQ / PO / GR / Bill / Purchase Return (CRUD-shaped, not lifecycle-shaped).

**Structural gaps (verified absent):**

1. **No Requisition layer.** No `purchase_requisitions` table, no requester → approver → buyer handoff, no demand-to-source funnel. PRs are the front door of enterprise P2P; today users start at PO.
2. **No Supplier Qualification / Onboarding domain.** `contacts` carries a supplier flag and rank; there is no qualification workflow, no compliance document lifecycle, no tax/bank verification state machine, no approved-supplier list separate from the contacts book.
3. **No Contracts / Blanket Agreements.** No `procurement_contracts`, no release orders against contract, no committed-spend tracking, no price/quantity ceilings, no expiry alerts. `vendor_pricelists` covers static price only.
4. **PO is a document, not a lifecycle object.** No versioning (`purchase_order_revisions`), no supplier acknowledgement (`po_acknowledgements`), no change orders, no line-level state (`open / acknowledged / partially_received / received / partially_billed / billed / closed / cancelled`) — only header status. No amendment audit.
5. **Goods Receipt is single-shot.** `complete_goods_receipt_atomic` implies terminal completion. Missing: multi-delivery against one PO, over/under-receipt policies, ASN/inbound-shipment linkage into GRN, substitution capture, damaged/rejected sub-quantities distinct from QC hold, pallet/carton/unit hierarchy at receipt, backorder auto-creation on short receipt. `backorders` table exists but is not wired from receiving.
6. **Procurement mutates inventory directly.** GR triggers still perform stock movement work inline instead of publishing a canonical `procurement.goods_received` event that WMS/Inventory subscribe to via the outbox. This is architectural drift — WMS already has its own event fabric (`business_event_outbox` + `warehouse.*` events).
7. **3-way match is a single RPC, not a state.** `match_bill_to_grn` exists but there is no persisted match result per line, no tolerance policy table, no exception queue, no 4-way (PO-GR-QC-Bill) path.
8. **No Supplier Performance domain.** No OTIF, no defect rate, no scorecard aggregation, no preferred-supplier ranking driven by measured performance (only manual rank on `contacts`).
9. **No Sourcing beyond RFQ.** No RFI, no RFP, no reverse auction, no sealed-bid controls, no scoring rubric.
10. **Approval workflow is generic.** `approval_workflows` exists globally but there is no procurement-specific policy (spend thresholds, category-based routing, delegation, out-of-office).
11. **UX is CRUD.** Record + peek pattern per entity. No unified P2P workbench, no buyer inbox, no receiver queue, no AP match queue, no supplier 360.

**Architectural drift found:**
- Stock mutation inside `complete_goods_receipt_atomic` overlaps WMS receive path (`create_goods_receipt` wrapper deferred in Phase 14a.2). Two receiving paths coexist.
- `trg_bill_to_cost` and `trg_purchase_order_to_cost` both feed cost — need to confirm one canonical costing path.
- `bill_grn_matches` and `sync_po_line_billed_quantities` both track billed progress; risk of divergence.
- Vendor identity split across `contacts` (as supplier) with no dedicated supplier master view — CRM leads and suppliers share the same table.

## 3. Target architecture

```text
              ┌──────────────────────────────────────────────┐
              │            Supplier Master Domain            │
              │  qualification · compliance · scorecards     │
              └───────────────┬──────────────────────────────┘
                              │ approved supplier list
                              ▼
     ┌──────────┐   ┌──────────────┐   ┌──────────────┐   ┌───────────┐
     │Requisition│→ │  Sourcing    │→ │  Contract /  │→ │ Purchase  │
     │  (PR)     │   │ RFI/RFQ/RFP │   │  Agreement   │   │  Order    │
     └──────────┘   └──────────────┘   └──────────────┘   └─────┬─────┘
                                                                │ po.issued
                                                                ▼
                                            ┌──────────────────────────┐
                                            │ Supplier Acknowledgement │
                                            │  + PO Change Orders      │
                                            └────────────┬─────────────┘
                                                         │ po.confirmed
                                                         ▼
                                      ┌──────────────────────────────────┐
                                      │ Inbound Shipment / ASN           │
                                      └────────────┬─────────────────────┘
                                                   │ inbound.expected
                                                   ▼
                     ┌─────────────────────────────────────────────────────┐
                     │  WMS (execution)  — receive · putaway · QC · count  │
                     └───────┬─────────────────────────────────────┬───────┘
             warehouse.received│                                   │warehouse.qc.*
                              ▼                                    ▼
                    ┌──────────────────┐               ┌────────────────────┐
                    │ Inventory quants │               │ Rejected / Return  │
                    │  + valuation     │               │ to supplier flow   │
                    └────────┬─────────┘               └────────────────────┘
                             │ inventory.received
                             ▼
                    ┌──────────────────────────────────────────┐
                    │ Finance: GRNI accrual · AP · GL · Pay    │
                    └────────┬─────────────────────────────────┘
                             │ bill.received → match → approve → pay
                             ▼
                    ┌──────────────────────────────────────────┐
                    │ Supplier Performance (OTIF, defects…)    │
                    └──────────────────────────────────────────┘
```

**Rules that hold everywhere:**
- Every state change is a row in `business_event_outbox` with idempotency key `procurement.<entity>.<id>:<state>`.
- Procurement never writes to `stock_quants`, `stock_movements`, `journal_entries`, or GL directly. It calls WMS/Inventory/Finance intent APIs, or emits events those domains consume.
- All RPCs `SECURITY DEFINER`, `SET search_path = public`, business-scoped, outbox emit.
- Line-level lifecycle everywhere (PR line, PO line, GR line, Bill line each carry their own state machine and match progress).

## 4. Execution plan (phased, incremental, each phase shippable)

### P0 — Foundation & drift removal
- Create `procurement_domain` audit doc in `.lovable/`.
- Add `business_event_outbox` topic prefixes: `procurement.*`, `sourcing.*`, `supplier.*`.
- Remove inline stock mutation from `complete_goods_receipt_atomic`; make it emit `procurement.goods_received` only. Land the deferred `create_goods_receipt` wrapper (Phase 14a.2) and route both WMS and Procurement receive paths through one canonical RPC.
- Reconcile `bill_grn_matches` + `sync_po_line_billed_quantities` into a single billed-progress view; add invariants test.
- Architecture guard test: assert Procurement RPCs never reference `stock_quants`, `stock_movements`, `journal_entry_lines` (except via wrapper).

### P1 — Supplier Master domain
Migrate supplier concerns off `contacts` into a first-class supplier surface (view + tables), without breaking existing contact rows.
- New tables: `suppliers` (1:1 with contact until decoupled), `supplier_qualifications`, `supplier_qualification_documents`, `supplier_compliance_checks`, `supplier_bank_accounts` (encrypted), `supplier_categories`, `approved_supplier_list` (per category, per business).
- RPCs: `submit_supplier_qualification`, `approve_supplier_qualification`, `suspend_supplier`, `reinstate_supplier`, `record_supplier_document_expiry`.
- Events: `supplier.qualification_submitted|approved|rejected`, `supplier.suspended|reinstated`, `supplier.document_expiring`.
- UI: Supplier 360 (identity, compliance, contracts, price lists, POs, GRs, bills, payments, scorecard).

### P2 — Contracts & Agreements
- New tables: `procurement_contracts`, `procurement_contract_lines` (price/qty/incoterms/lead time), `procurement_contract_releases` (each PO cites zero-or-one contract line).
- Enforce ceilings at PO approval; expiring-soon alerts via outbox.
- UI: Contracts workbench.

### P3 — Requisition (PR)
- New tables: `purchase_requisitions`, `purchase_requisition_items`, `purchase_requisition_approvals` (or reuse `approval_requests` with a procurement policy).
- Category-based routing, delegation, spend thresholds, budget check hook (reads `budgets`).
- Convert PR → RFQ or PR → PO (contract release path).
- Events: `procurement.requisition.submitted|approved|rejected|converted`.
- UI: Requester form, buyer inbox.

### P4 — Sourcing (RFI/RFQ/RFP, scoring)
- Extend existing `rfqs` to a `sourcing_events` supertype with `kind in ('rfi','rfq','rfp','auction')`; add `sourcing_scoring_criteria`, `sourcing_vendor_scores`, sealed-bid open time, award justification.
- Reverse-auction later (feature-flagged).
- Events: `sourcing.published|bid_received|closed|awarded`.

### P5 — Purchase Order lifecycle
- Add `purchase_order_revisions` (immutable snapshots), `purchase_order_acknowledgements` (supplier confirms/proposes changes), `purchase_order_change_orders`.
- Line-level state machine on `purchase_order_items.state`: `open|acknowledged|partially_received|received|partially_billed|billed|closed|cancelled`.
- RPCs: `issue_purchase_order`, `acknowledge_purchase_order`, `create_po_change_order`, `close_po_line`, `cancel_po_line`.
- Events: `procurement.po.issued|acknowledged|amended|line_closed|cancelled`.
- Vendor portal: acknowledge / propose changes / view ASN status.

### P6 — Inbound Shipment / ASN
- Promote `inbound_shipments` to first-class expected-delivery object; carriers, ETA, tracking, packing list, per-line expected qty.
- Bind ASN → PO lines; drive WMS dock appointments (`wms_dock_appointments`) and receiving suggestions.
- Events: `procurement.inbound.expected|arrived|cancelled`.

### P7 — Goods Receipt reconstruction
- Support multi-delivery: `goods_receipts` becomes `receipt_headers` per delivery; PO line accumulates received qty across many receipts.
- Add fields: over/under policy per line (from contract), substitution, damaged qty, rejected qty (distinct from QC hold), pallet/carton/unit capture (via `wms_license_plates`, `wms_pack_cartons`).
- Backorder auto-creation on short receipt (wire existing `backorders`).
- QC integration: GR line with `requires_qc=true` opens `wms_qc_inspections`; only accepted qty becomes available inventory; rejected qty routes to `purchase_returns` proposal.
- Events: `procurement.gr.line_received|short_received|over_received|damaged|substituted|qc_opened|qc_accepted|qc_rejected`.

### P8 — 3-way / 4-way match & AP
- New tables: `bill_match_results` (per bill line: PO line + GR line + optional QC pass, variance qty, variance price, tolerance policy applied, outcome `matched|held|approved_with_variance`).
- `procurement_match_tolerance_policies` (per business + per category).
- Exception queue UI for AP clerks.
- Events: `procurement.bill.matched|held|variance_approved`.

### P9 — Returns to Supplier & Vendor Credit
- Formalise the reject → RTS → vendor credit chain: rejected GR qty auto-drafts a `purchase_returns` request; approval creates outbound shipment via WMS; vendor credit note reconciles AP.
- Events: `procurement.return.drafted|approved|shipped|credited`.

### P10 — Supplier Performance
- New tables: `supplier_scorecards`, `supplier_scorecard_periods`, `supplier_kpi_snapshots` (OTIF, defect rate, price variance, lead-time variance, response time).
- Nightly job aggregates from events; feeds `approved_supplier_list` ranking.
- UI: scorecard on Supplier 360.

### P11 — Workbench UX (replaces CRUD pages)
- **Buyer workbench**: requisition inbox, sourcing pipeline, contract shelf, PO tracker with acknowledgement + receipt + billing progress bars per line.
- **Receiver workbench**: today's expected shipments, dock schedule, in-progress receipts, QC holds.
- **AP workbench**: match queue, variance exceptions, ready-to-pay, payment run builder.
- **Supplier 360**: single pane per supplier across all domains.
- Keep peek sheets; retire the CRUD "record" pages once workbench flows cover them.

### P12 — E2E harness (mirror WMS Phase 14)
Playwright project `procurement`. Specs: `requisition.spec.ts`, `sourcing.spec.ts`, `contract-release.spec.ts`, `po-lifecycle.spec.ts` (issue → ack → change order), `receive-multi.spec.ts` (partial + over + damaged), `qc-integration.spec.ts`, `match.spec.ts` (2/3/4-way + tolerance), `return-credit.spec.ts`, `performance.spec.ts`. Architecture guard: no `describe.skip`, canonical RPC list must exist in `pg_proc`, Procurement RPCs must not touch stock/GL tables directly.

### P13 — RLS & governance re-audit
Re-audit RLS on every new table; ensure vendor portal users see only their supplier scope; add `governance_sod_conflicts` entries for requester ≠ approver ≠ buyer ≠ receiver ≠ AP.

## 5. Technical appendix

- **Event fabric:** reuse `business_event_outbox`. Topics: `supplier.*`, `procurement.requisition.*`, `sourcing.*`, `procurement.po.*`, `procurement.inbound.*`, `procurement.gr.*`, `procurement.bill.*`, `procurement.return.*`, `procurement.performance.*`. Idempotency: `<topic>:<entity_id>:<state>`.
- **RPC conventions:** all new RPCs `SECURITY DEFINER`, `SET search_path = public`, business-scoped via `has_business_access(auth.uid(), business_id)`, atomic (single transaction), outbox emit in same tx.
- **Grants:** every new `public.*` table gets `GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated; GRANT ALL ... TO service_role;` in the same migration; `anon` only for genuinely public reads (none here).
- **Backfill:** each phase includes a backfill migration + a reversible flag; no destructive drops until the workbench replaces the CRUD page for that entity.
- **Guards:** architecture tests forbid Procurement code from importing WMS/Inventory/Finance mutation helpers; enforced in `src/test/architecture/procurement.test.ts`.

## 6. Sequencing & shippability

P0 → P3 lands the demand-to-commitment spine. P5 → P7 rebuilds fulfilment on the WMS event fabric. P8 → P9 finishes settlement. P10 → P11 unlocks the workbench UX and closes the loop. Every phase is independently shippable behind feature flags; no phase is "done" until its E2E spec is unskipped and asserts real read-back state (table + outbox), matching the WMS Phase 14 standard.

## 7. Out of scope for this plan
- POS-side receiving (handled by WMS mobile).
- Manufacturing procurement of components (later phase).
- Multi-entity intercompany PO — deferred until entity model is finalised.

---

## Execution log

### 2026-07-18 — WMS Phase 14 E2E harness (closed)
- 14a scaffolding: Playwright projects `wms` + `wm` wired, idempotent `wms_e2e_ensure_seed()` operational.
- 14a.1: 6 canonical wrapper RPCs verified in `pg_proc` (`assign_wms_task`, `claim_pick_task`, …).
- 14b–14e: `receive`, `putaway`, `wave`, `pick-pack-dispatch` specs active and green against live DB state.
- 14f (QC): seed extended with `wms_qc_hold_reasons` (`E2E_HOLD`, idempotent per business); `qc.spec.ts` asserts accept / reject-scrap / cancel lifecycles, stock-movement row counts, and `warehouse.qc.*` outbox events with ADR-0076 idempotency keys.
- 14g (Count): `count.spec.ts` covers `create_count_session` → `record_count_scan` (variance) → `approve_count_variance` → `post_count_session`; asserts `posted_adjustment_id` + `warehouse.count.posted` events.
- 14h (Offline drain): `e2e/wm/offline-drain.spec.ts` seeds a `claim_pick_task` op into IndexedDB `wm-offline-queue`, dispatches synthetic `online`, verifies queue drain + server task advances to `assigned`.
- 14i (Guard): `src/test/architecture/wms-phase14.test.ts` forbids `describe.skip` in Phase 14 specs.
- Dep restoration: `bun install` re-hydrated `react-router-dom`, `framer-motion`, `idb`, `qrcode.react` — build gate green.
- **Deferred (non-blocking):** 14a.2 `create_goods_receipt` canonical WMS wrapper — folded into Procurement P0.

### 2026-07-18 — Procurement P1 (Supplier Master shipped)
- `.lovable/procurement-domain-audit.md` created.
- Migration `procurement_p1_supplier_master`: 7 tables (`supplier_categories`, `suppliers`, `supplier_qualifications`, `supplier_qualification_documents`, `supplier_compliance_checks`, `supplier_bank_accounts`, `approved_supplier_list`) with full GRANTs, business-scoped RLS via `user_has_business_access(auth.uid(), business_id)`, and `updated_at` triggers.
- Backfill: every `contacts.type IN ('supplier','both')` has a matching `suppliers` row (`lifecycle_state='approved'`, idempotent).
- Lifecycle RPCs: `submit_supplier_qualification`, `approve_supplier_qualification`, `reject_supplier_qualification`, `suspend_supplier`, `reinstate_supplier`. All `SECURITY DEFINER`, self-approval blocked, `supplier.*` outbox events emitted with idempotency keys.

## Phase status board

| Phase | Scope | Status |
|---|---|---|
| WMS 14a–14i | E2E harness (receive, putaway, wave, pick-pack-dispatch, QC, count, offline drain, guard) | ✅ Shipped |
| WMS 14a.2 | Canonical `create_goods_receipt` wrapper unifying WMS + Procurement receive paths | ⏸ Deferred → folded into Procurement P0 |
| Proc P0 | Foundation & drift removal (outbox topics, unify GR paths, reconcile bill/PO billed-progress, architecture guard test) | 🔜 Next |
| Proc P1 | Supplier Master domain (tables + lifecycle RPCs + events) | ✅ Shipped (UI pending) |
| Proc P1-UI | Supplier 360 workbench surface | ⏳ Pending |
| Proc P2 | Contracts & Agreements | ⏳ Pending |
| Proc P3 | Requisitions (PR) | ⏳ Pending |
| Proc P4 | Sourcing (RFI/RFQ/RFP + scoring) | ⏳ Pending |
| Proc P5 | PO lifecycle (revisions, acknowledgement, change orders, line state machine) | ⏳ Pending |
| Proc P6 | Inbound Shipment / ASN promotion | ⏳ Pending |
| Proc P7 | Goods Receipt reconstruction (multi-delivery, damaged/rejected, backorder wiring, QC integration) | ⏳ Pending |
| Proc P8 | 3-way / 4-way match + tolerance policies + AP exception queue | ⏳ Pending |
| Proc P9 | Returns to Supplier + Vendor Credit chain | ⏳ Pending |
| Proc P10 | Supplier Performance (scorecards, KPI snapshots, nightly aggregation) | ⏳ Pending |
| Proc P11 | Workbench UX (Buyer / Receiver / AP / Supplier 360) | ⏳ Pending |
| Proc P12 | Procurement E2E Playwright harness (mirrors WMS 14) | ⏳ Pending |
| Proc P13 | RLS + governance re-audit, SoD conflicts, vendor portal scope | ⏳ Pending |

## Next up — chronological pickup order

The next agent picks up here without re-planning. Verify first, then advance:

1. **Verify P1 in DB** — confirm the 7 tables exist with GRANTs + RLS enabled, backfill covered all vendor-typed contacts, and the 5 lifecycle RPCs are present in `pg_proc` and emit `supplier.*` rows into `business_event_outbox`. Read `.lovable/procurement-domain-audit.md` for the verified-state ledger.
2. **Ship P0 (drift removal)** — blocker for everything downstream:
   - Land the `create_goods_receipt` canonical wrapper (previously WMS 14a.2); route both WMS receive and Procurement GR through it.
   - Strip inline stock mutation from `complete_goods_receipt_atomic`; replace with `procurement.goods_received` outbox emit; add a subscriber that calls the WMS wrapper.
   - Register outbox topic prefixes `procurement.*`, `sourcing.*`, `supplier.*` in the topic registry.
   - Reconcile `bill_grn_matches` + `sync_po_line_billed_quantities` into a single `v_po_line_billed_progress` view; add invariants test.
   - Add `src/test/architecture/procurement.test.ts`: forbid Procurement RPC bodies from referencing `stock_quants`, `stock_movements`, `journal_entry_lines` (except via the canonical wrapper).
3. **Ship P2 (Contracts)** — `procurement_contracts`, `procurement_contract_lines`, `procurement_contract_releases`; enforce ceilings at PO approval; expiring-soon outbox alerts.
4. **Ship P3 (Requisitions)** — `purchase_requisitions` + items + approvals; category-based routing; budget-check hook; PR→RFQ and PR→PO(contract release) converters; `procurement.requisition.*` events.
5. Then strict order **P4 → P5 → P6 → P7 → P8 → P9 → P10**, UX in **P11**, harness in **P12**, governance re-audit in **P13**. No phase closes until its E2E spec is unskipped and asserts read-back state + outbox rows (WMS Phase 14 standard).

**Guardrails held across every phase:**
- Procurement never writes to `stock_quants`, `stock_movements`, `journal_entries` — only emits events or calls WMS/Inventory/Finance intent wrappers.
- Every new `public.*` table ships with GRANTs + RLS + `updated_at` trigger in the same migration.
- Every lifecycle RPC is `SECURITY DEFINER`, `SET search_path = public`, business-scoped, atomic, and emits `<topic>:<entity_id>:<state>` idempotency keys.
- Approver ≠ submitter enforced in-RPC; SoD conflicts registered in `governance_sod_conflicts` at P13.
