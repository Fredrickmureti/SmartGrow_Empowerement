
# Inventory Replenishment — architecture verdict & engineering plan

## 1. Verdict (what actually exists today)

The subsystem is **~30% of an enterprise planning engine** — a competent net-requirement calculator wrapped in a passive dashboard. What is real:

- `product_reorder_rules` — safety stock, MOQ, pack size, lead time, preferred vendor, `source_strategy` (unused), optional branch/warehouse scope.
- `replenishment_runs` — audit header per planning execution.
- `procurement_recommendations` — one row per (product, branch) shortage, with `explanation` JSON and an `open / snoozed / dismissed / actioned` status.
- `run_replenishment_planning(business, branch, trigger)` RPC — reads on-hand from `warehouse_stock`, open-PO incoming, and 28-day trailing outbound velocity; computes `safety + lead-demand − available − incoming`, rounds to MOQ/pack, classifies urgency.
- `src/lib/replenishment/engine.ts` — pure TS mirror kept in sync with the SQL.
- Workspace `/inventory-app/replenishment` (`ReplenishmentLog.tsx`) — KPIs, urgency filter, "Why" dialog, snooze/dismiss, runs tab, legacy auto-PO log tab.

What is **missing** vs. Odoo/SAP/Dynamics/ERPNext-class MRP:

| # | Gap | Impact |
|---|---|---|
| 1 | No path from recommendation → PO / transfer / MO. `actioned_ref_type/id` columns exist but nothing writes them. | Recommendations are read-only wallpaper. |
| 2 | `suggested_source` is hard-coded `'buy'`. `source_strategy` on the rule is ignored. No transfer or manufacture sourcing. | Multi-warehouse and make-vs-buy invisible. |
| 3 | No approval workflow. Platform has `approval_workflows` / `approval_requests`; planning does not feed them. | Cannot enforce planner ≠ approver ≠ buyer SoD. |
| 4 | Snooze is binary — no `snooze_until`, no assignee, no comments, no merge, no edit-qty, no per-line regenerate, no lifecycle audit. | Not a work item, just a badge. |
| 5 | No open-PO tie-back per recommendation. Incoming is a scalar sum. | Planner cannot see "PO#123 already resolves this on Wed". |
| 6 | Demand = 28-day trailing outbound only. Sales orders, backorders, reservations-over-time, forecasts, seasonality, BOM explosion — all ignored. | Not time-phased. Cannot MRP. |
| 7 | Vendor sourcing = single `preferred_supplier_id`. `vendor_pricelists` (price breaks, per-vendor lead time, per-vendor MOQ) not consulted. | No vendor selection intelligence. |
| 8 | Sums across warehouses per branch — no per-warehouse recommendation, no lateral transfer suggestion when one warehouse is long and another short. | Encourages over-buying. |
| 9 | Lot / expiry ignored. FEFO exists (ADR-0025) but near-expiry stock still counted as available. | Overstates cover. |
| 10 | Only `manual` run type is wired. `scheduled` / `event` enums exist but no pg_cron and no event triggers (low-stock, new sales order, PO cancellation). | Planners must remember to click. |
| 11 | Legacy `replenishment_logs` (auto-PO) lives on a separate tab with its own lifecycle, disconnected from recommendations. | Two truths; tech debt. |
| 12 | No notifications on run completion, new stock-outs, or newly critical items. | Silent engine. |
| 13 | No planning reports (supplier proposal, shortage list, plan-vs-actual). | Nothing to send to a buyer or CFO. |
| 14 | No rules-management page in nav. `useProductReorderRules` exists but planners can't triage rule coverage. | Cold start invisible. |

## 2. Target architecture (single-page)

```text
                         ┌──────────────────────────────────┐
   Demand signals ──────►│                                  │
   (SO backlog,          │        Planning Engine           │
    reservations,        │  (run_replenishment_planning v2) │
    28d velocity,        │                                  │──► procurement_recommendations
    forecast horizon)    │  time-phased, per-warehouse,     │     (open → in_review →
                         │  vendor-aware, source-aware      │      approved → executing →
   Supply signals ──────►│                                  │      fulfilled / cancelled)
   (on-hand, open POs    │                                  │
    with ETA, open       └────────────────┬─────────────────┘
    transfers, MOs,                       │
    lots+expiry)                          ▼
                                 ┌────────────────┐
   Rules ───────────────────────►│ Recommendation │──► converts to
   (reorder rules,               │   work items   │     • Purchase Order (rec_id stamped)
    vendor pricelists,           │  (assignable,  │     • Stock Transfer (rec_id stamped)
    source_strategy,             │   mergeable,   │     • Manufacturing Order (future)
    approval rules)              │   auditable)   │
                                 └────────┬───────┘
                                          │
                                          ▼
                                 Approval workflow (SoD)
                                          │
                                          ▼
                             Notifications + digest email
                                          │
                                          ▼
                       Planning reports (shortage, supplier proposal)
```

Sourcing decision order (per rule `source_strategy`):
1. `prefer_transfer` → if another accessible warehouse in the same business has surplus > safety, emit `transfer` rec first.
2. `prefer_manufacture` → if product has an active BOM, emit `manufacture` rec (phase 3).
3. Otherwise `buy` — pick vendor via `vendor_pricelists` (best price at required qty, respecting per-vendor MOQ & lead time), fallback to `preferred_supplier_id`.

## 3. Phased delivery

Each phase ends with the module still shippable. No user question needed — scope is inferred from mature ERP norms.

### Phase 1 — Recommendation becomes a work item (foundation)
- DB: extend `procurement_recommendations` with `status` values `in_review, approved, executing, fulfilled, cancelled`; add `snooze_until`, `assignee_id`, `linked_po_id`, `linked_transfer_id`, `linked_mo_id`, `approval_request_id`, `edited_qty`, `override_reason`.
- DB: `procurement_recommendation_events` audit table (who did what, when, from/to status).
- RPC `convert_recommendation_to_po(rec_id, vendor_id?, qty?, notes?)` — creates a draft PO under Purchases rules, stamps `linked_po_id`, transitions status to `executing`, writes audit event. Rec auto-flips to `fulfilled` when the linked PO's GRN closes the qty.
- RPC `convert_recommendation_to_transfer(rec_id, from_wh, to_wh, qty?)` — same shape for `stock_transfers`.
- RPC `merge_recommendations(ids[])` (same product+vendor, aggregate qty).
- Workspace: bulk-select, "Create PO", "Create transfer", "Assign to…", "Snooze until", edit qty inline, per-row audit drawer.

### Phase 2 — Sourcing & demand intelligence
- Engine v2: per-warehouse rows (not per-branch aggregate); consult `vendor_pricelists` for vendor + effective MOQ/lead-time; honour `source_strategy` to emit transfer recs before buy recs.
- Demand: add open `sales_order_items` + `backorders` (net of already-shipped) to the shortage horizon; expose `demand_open_orders` in `explanation`.
- Show incoming as line-item tie-back: rec drawer lists the PO lines + ETAs that already cover part of the need.
- Lot/expiry: subtract stock expiring inside `lead_time_days + safety_days` from "available" (rule flag `exclude_expiring`).

### Phase 3 — Automation, approvals, notifications
- pg_cron nightly `run_replenishment_planning('scheduled')` per business; also incremental event runs when a rule fires (low-stock trigger, PO cancellation, big new SO).
- Wire into existing `approval_workflows`: rules can require approval for `value > X` or `urgency = planned`; recs enter `in_review` and use platform approval engine.
- Notifications: on run finish (digest of net new stock-outs), on approval requested/granted, on recommendation reaching `needed_by` with no linked PO.
- Retire `replenishment_logs`: migrate any live rows into recommendations w/ `linked_po_id`, remove the auto-PO tab, redirect it to a filtered view of executed recs.

### Phase 4 — Reporting & rule governance
- Rules management page under Inventory → Setup (safety-stock coverage %, orphan products with no rule, rule effectiveness — recs generated vs. fulfilled).
- Reports: Shortage report, Supplier proposal (grouped by vendor, exportable), Plan-vs-actual (recommended qty vs. purchased qty vs. received qty).
- Optional: MRP-II BOM explosion for manufacturing recs (deferred; requires MO module).

## 4. Guardrails preserved

- Planner writes recommendations, Purchases writes POs, Warehouse writes GRNs — SoD unchanged (ADR-0016).
- Every conversion RPC runs `SECURITY DEFINER` with `user_can_access_business` + `can_access_branch` + `user_has_module_permission('purchases'|'inventory')`.
- TS engine (`src/lib/replenishment/engine.ts`) stays bit-for-bit equivalent to the SQL — a new architecture test asserts identical output on a seeded fixture.
- Branch stamping trigger on `stock_movements` continues to derive `branch_id` from warehouse (inventory audit verdict retained).

## 5. Out of scope for this handoff

- True statistical forecasting (Holt-Winters, ML). Phase 2 uses SO backlog + trailing velocity as demand; forecast is a separate future workstream.
- Manufacturing order emission (needs MO module).
- Multi-echelon (DC → store) DRP.
- Consignment / VMI sourcing.

## 6. Deliverables of this plan when built

- Migration set for phases 1–3 (schema, RPCs, cron, RLS).
- Refactored `ReplenishmentLog.tsx` (renamed `InventoryPlanning`) with work-item behaviour; new `RecommendationDrawer`, `SourcingPicker`, `RulesCoverage` components.
- New tests: engine parity (SQL vs TS), conversion RPC RLS/SoD, notification triggers, cron dispatcher.
- Documentation update: `docs/audit/inventory-verdict.md` extended with a "Planning" section; new ADR "Replenishment recommendation lifecycle & sourcing" superseding the passive-log model.

Approve to move into Phase 1 implementation; I will not touch phases 2–4 in the same pass.
