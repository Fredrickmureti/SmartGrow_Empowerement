
# Inventory Replenishment — Enterprise Audit & Redesign Plan

## 1. Verdict on the current subsystem

Reading the code (not the marketing copy):

- `src/pages/ReplenishmentLog.tsx` is the entire UX: one **Run** button, three counters (Total / PO Created / Failed), and a log grid.
- `useReplenishmentLogs.triggerReplenishment()` calls the edge function `check-inventory-alerts`.
- `check-inventory-alerts` is gated by `requireCronAuth` — it only accepts `Authorization: Bearer <SERVICE_ROLE_KEY>`. A browser session can never satisfy that. **That is the auth/CORS failure**: the endpoint is a cron endpoint being called from the UI.
- The engine itself is the SQL RPC `auto_create_replenishment_po()`. It reads `products.stock_quantity` + `products.reorder_level` (org-level scalars) and directly writes `purchase_orders`. It ignores everything the rest of the ERP already models:
  - branch / warehouse stock (`warehouse_stock`, branch-scoped per the inventory audit doc),
  - open incoming POs (in-transit netting),
  - reservations (`stock_reservations`, `pos_stock_reservations`),
  - lots / expiry (`stock_lots`),
  - stock transfers between warehouses,
  - supplier lead time, MOQ, price breaks, preferred vendor,
  - demand / velocity (`getReplenishmentSignal` already computes days-of-supply but is unused by the engine),
  - manufacturing as an alternative source,
  - approval / procurement segregation of duties.

**Conclusion.** This is not enterprise replenishment. It is an org-wide auto-PO button. In Odoo / SAP / D365 / Oracle SCM terms, we are missing the entire **procurement recommendation** layer. Fixing the CORS error would ship an architecturally wrong feature faster. We fix the architecture first.

## 2. Target architecture (Odoo/SAP-class)

Business events (canonical lifecycle):

```text
stock movement / sales order / forecast change / reorder rule change
        │
        ▼
  Replenishment Engine  (scheduled + event-driven + on-demand)
        │
        ▼
  Procurement Recommendations  (net requirement per product × branch)
        │  explain(): on-hand, reserved, incoming, DoS, lead time, safety
        ▼
  Sourcing decision:  Buy  │  Transfer  │  Manufacture  │  Ignore
        │
        ▼
  Draft Purchase Requisition / Transfer / MO   ← reviewed by planner
        │
        ▼
  Approval (SoD: planner ≠ approver ≠ receiver)
        │
        ▼
  Purchase Order / Internal Transfer / MO release
        │
        ▼
  Receipt  →  stock_movements  →  loop closes
```

Rules that follow from this:

- The engine emits **recommendations**, not POs. POs are created by Purchasing after review/approval. That preserves SoD and reuses the existing purchases module (allocation-first payments, GRN, etc.).
- Requirements are calculated **per (product, branch/warehouse)**, not org-wide. This matches the inventory audit's branch-isolation invariants and the existing `warehouse_stock` / `product_reorder_rules.branch_id` model.
- Net requirement = `max(0, safety_stock + forecast_demand − on_hand + reserved − incoming_open_pos − incoming_transfers)`, rounded up to supplier MOQ / pack size.
- Every recommendation is **explainable**: it stores the inputs it used (snapshot) so the planner can audit why the number was proposed.
- Execution modes:
  1. **On-demand** — planner clicks "Run planning" from the workspace. Runs as the current user via a TanStack server function with `requireSupabaseAuth`, RLS applies, no service-role, no CORS games.
  2. **Scheduled** — pg_cron hits a public route (`/api/public/hooks/replenishment-run`) authenticated with the `apikey` anon header per the schedule-jobs guidance. That route calls the same engine with a system actor.
  3. **Event-driven** — DB triggers on `stock_movements` / `sales_order_items` mark affected (product, branch) pairs as "dirty" in a `replenishment_dirty_keys` queue; the scheduled run only recomputes dirty keys (cheap, correct).

## 3. Scope of work

### Phase A — Domain model (SQL migrations)

New tables (all with `organization_id`, `business_id`, `branch_id` where applicable, GRANTs, RLS mirroring the inventory audit pattern):

- `procurement_recommendations` — one row per (run_id, product_id, branch_id). Columns: `net_requirement`, `suggested_qty`, `suggested_source` (`buy|transfer|manufacture`), `preferred_vendor_id`, `preferred_source_warehouse_id`, `urgency` (`stockout|critical|low|planned`), `needed_by`, `explanation jsonb` (snapshot of on-hand/reserved/incoming/velocity/lead-time/safety), `status` (`open|snoozed|dismissed|actioned`), `actioned_ref` (PO / transfer / MO id).
- `replenishment_runs` — one row per engine invocation. Columns: `run_type` (`manual|scheduled|event`), `triggered_by`, `params jsonb`, counts, duration, `status`.
- `replenishment_dirty_keys` — event queue populated by triggers on `stock_movements`, `sales_order_items`, `purchase_order_items`, `product_reorder_rules`.
- Extend `product_reorder_rules` (nullable, backward-compatible): `safety_stock`, `lead_time_days`, `pack_size`, `moq`, `preferred_vendor_id`, `source_strategy` (`buy_only|prefer_transfer|prefer_manufacture`).

Keep the existing `replenishment_logs` table but re-purpose it as the **execution audit trail** (what the planner actioned), pointed to by `procurement_recommendations.actioned_ref`. Do not drop it — it is referenced by types and the log page.

Deprecate `auto_create_replenishment_po()`: keep the function but make it a thin wrapper that (a) runs the new engine and (b) auto-actions only recommendations flagged `auto_action=true` on the rule — off by default.

### Phase B — Engine (server-side, deterministic, testable)

- Pure TS module `src/lib/replenishment/engine.ts` that takes a snapshot (rules, warehouse stock, open POs, open transfers, velocity from the existing `getReplenishmentSignal` window, forecast if present) and returns recommendations. Pure = fully unit-testable.
- Server function `runReplenishmentPlanning` (createServerFn + `requireSupabaseAuth`) that:
  1. loads the snapshot with RLS as the calling user (branch-scoped),
  2. calls the pure engine,
  3. writes a `replenishment_runs` row and `procurement_recommendations` rows,
  4. returns the run id + summary counts.
- Public route `app/routes/api/public/hooks/replenishment-run.ts` for pg_cron, authenticated with the anon `apikey` header per the schedule-jobs contract; internally uses `supabaseAdmin` and iterates orgs where entitlement + subscription pass (reuse `checkSubscriptionActive`).
- DB triggers to enqueue dirty keys; the scheduled run recomputes only those.

### Phase C — Planner workspace UX (replaces the current page)

Rename the current `/inventory-app/replenishment` page from a log to an **Inventory Planning Workspace**:

- Header: KPIs — Stock-outs, Critical (<7d cover), Low (<14d cover), Overstock, Open POs incoming, Pending recommendations.
- Primary table: **Recommendations to review** — one row per (product × branch), columns: Product, Branch, On hand, Reserved, Incoming, Days of supply, Suggested qty, Source (Buy/Transfer/MO), Preferred vendor, Needed by, Urgency, Why? (opens the `explanation` snapshot), Actions (Create PO / Create Transfer / Create MO / Snooze / Dismiss).
- Bulk selection → "Create draft purchase requisitions" (grouped by vendor, respecting MOQ / pack size) → hands off to the existing Purchases module in **draft** state. Purchasing then approves and converts to PO. This is the SoD boundary.
- Secondary tabs: **Runs** (history of engine executions), **Log** (the existing `replenishment_logs` view, kept for continuity).
- Every recommendation exposes a "Why?" panel rendering the snapshot: on-hand, reserved, incoming, velocity window, safety stock, lead time, MOQ, rounding — the number is always explainable.

### Phase D — Wire cron correctly + kill the CORS bug

- Remove the browser-side `supabase.functions.invoke("check-inventory-alerts")` call. Manual runs go through the new TanStack server function (session-authenticated, no CORS).
- pg_cron schedule (nightly + hourly for stock-out-only pass) targets the new public route with the anon apikey header, following the schedule-jobs pattern verbatim. No new shared-secret env var.
- `check-inventory-alerts` stays for now but is trimmed to: subscription check + email/SMS alerts. The replenishment call moves out. Once callers migrate, the old function can be deleted.

### Phase E — Tests & guards

- Unit tests for the pure engine across the tiers already defined in `replenishmentSignal.test.ts`, plus MOQ/pack rounding, in-transit netting, transfer preference, multi-branch isolation.
- Architecture test: no client code may call `check-inventory-alerts`, and no code outside `src/lib/replenishment/` may write to `procurement_recommendations`.
- RLS tests: cross-branch and cross-business isolation for the new tables (mirroring `inventory-branch-filter.test.ts`).
- SoD test: the server function that turns a recommendation into a PO refuses if the calling user is the same as the planner who created the recommendation, when the org has SoD enabled (reuse existing `sod-self-action` memory pattern).

## 4. Order of execution

1. Phase A migrations (tables, GRANTs, RLS, triggers, dirty-key queue).
2. Phase B engine + server function + public cron route.
3. Phase C planner workspace (keeps the old log page reachable as a sub-tab during migration).
4. Phase D remove browser → cron-authed function call; schedule pg_cron against the new public route.
5. Phase E tests + architecture guards.
6. Retire `auto_create_replenishment_po` after one release cycle, once dashboards show zero callers.

## 5. Non-goals (called out explicitly)

- Not building a forecasting model in this pass — the engine accepts a forecast input, and until a real forecast exists it falls back to trailing-28-day velocity (already implemented by `getReplenishmentSignal`).
- Not building MRP / bill-of-materials explosion — Manufacturing is a valid `suggested_source` but MO creation stays a stub handoff to the (future) manufacturing module.
- Not touching Purchases internals — recommendations hand off **draft** requisitions; the Purchases module owns approval → PO → GRN unchanged.

---

### Technical notes for reviewers

- New tables follow the mandatory public-schema pattern: `CREATE TABLE` → `GRANT SELECT,INSERT,UPDATE,DELETE TO authenticated; GRANT ALL TO service_role;` → `ENABLE RLS` → policies using `user_can_access_business(uid, business_id) AND can_access_branch(uid, branch_id) AND user_has_module_permission(..., 'inventory', ...)` — identical shape to the tables listed in `docs/audit/inventory-verdict.md`.
- Manual run path: TanStack server function with `.middleware([requireSupabaseAuth])` and `attachSupabaseAuth` in `src/start.ts` — no service-role from the browser, no CORS shim.
- Scheduled path: pg_cron + pg_net POSTing to `/api/public/hooks/replenishment-run` with `apikey: <anon key>`, per the schedule-jobs contract. No custom `CRON_SECRET`.
- The pure engine module lives outside `src/server/` so it can be imported by both the server function and unit tests, matching the server-function-authoring guidance.
