
# Enterprise Procurement — Continuation Plan

## Phase 1 — Verification of previous engineer's claims (evidence-backed)

Cross-checked the previous plan (`.lovable/plan.md`) against `pg_proc`, `information_schema`, and repo files. Findings:

| Claim in plan | Evidence | Verdict |
|---|---|---|
| P0 topic registry + subscriptions seeded | 14 rows across `procurement.*` / `supplier.*` / `sourcing.*`; 2 subscriptions on `procurement.gr.posted` (→ `wms_apply_gr_stock`, `finance_post_gr_journal`) | ✅ real |
| `complete_goods_receipt_atomic` no longer writes stock/finance tables | `pg_get_functiondef` contains **zero** matches for `stock_movements\|stock_quants\|cost_layers\|journal_entries\|journal_entry_lines` | ✅ real |
| Canonical `create_goods_receipt` + WMS/finance splitter RPCs exist | `create_goods_receipt`, `wms_apply_gr_stock`, `finance_post_gr_journal` all in `pg_proc` | ✅ real |
| Arch guard `src/test/architecture/procurement.test.ts` | file present | ✅ real |
| P1 Supplier Master (7 tables + 5 lifecycle RPCs) | tables + `submit/approve/reject_supplier_qualification`, `suspend/reinstate_supplier` in `pg_proc` | ✅ structurally shipped, but **0 rows** in `suppliers`, **0** `supplier.*` outbox events — never runtime-exercised |
| P2 Contracts (3 tables + 4 RPCs + ceiling trigger) | tables + `create/activate/terminate/amend_procurement_contract` present | ✅ structurally shipped, **0 rows** — trigger path unexercised |
| P3 Requisitions (3 tables + 4 lifecycle RPCs) | tables + `submit/approve/reject/cancel_requisition` present | ✅ structurally shipped, **0 rows** |
| Types regen picked up new tables | 13 occurrences of the new table names in `src/integrations/supabase/types.ts` | ✅ real |
| P1-UI / P2-UI / P3-UI workbenches | `src/apps/purchases/pages/` directory does not exist; nav has no supplier/contract/requisition entries | ❌ confirmed not started (matches plan) |
| P4 Sourcing, P5 PO lifecycle, P6 ASN, P7 GR reconstruction, P8 Match, P9 Returns, P10 Scorecards, P11 Workbench UX, P12 Playwright, P13 RLS re-audit | none of the target tables (`sourcing_events`, `purchase_order_revisions`, `receipt_deliveries`, `bill_match_results`, `supplier_scorecards`) exist | ❌ confirmed not started |

**Nothing shipped is fraudulent.** Backend for P0–P3 is genuinely in place; the outstanding integrity gap is that no runtime path has produced a single `supplier.*` / `procurement.contract.*` / `procurement.requisition.*` outbox row — the RPCs are code-inspected only. The plan already routes this into the P12 E2E harness, which is the right home for it.

## Phase 2 — Plan validation & amendments

The previous plan is architecturally sound. I am adopting it with these evidence-driven amendments:

1. **Runtime smoke coverage cannot wait for P12.** P12 is 8+ phases away. Add a lightweight **"phase-close smoke" migration** convention: at the end of each backend phase, a `pg_temp` DO-block that spoofs `auth.uid()` via a service-role seed row and asserts one outbox row per lifecycle transition. Runs once in the migration and is thrown away. Blocks a phase from being marked shipped without at least one real transition emitted.
2. **Contract ceiling trigger** has never fired. The P2-UI batch must include a Playwright-independent unit-style pgTAP-lite assertion that a PO exceeding a contract line ceiling is rejected and emits `procurement.contract.ceiling_breached_attempt`.
3. **Requester ≠ approver ≠ buyer ≠ receiver ≠ AP SoD conflicts** (planned in P13) must be declared as `governance_sod_conflicts` rows **at the moment each RPC lands**, not batched to the end. Cheap and prevents drift.
4. **P7 GR reconstruction** must retire the legacy single-header `goods_receipts` writes from *every* remaining caller (not only `complete_goods_receipt_atomic`). Add an arch guard that only the canonical `create_goods_receipt` wrapper may insert into `goods_receipts` / `goods_receipt_items`.
5. **P8 4-way match** — confirmed already noted; also add `bill_match_results.landed_cost_bill_id` nullable FK so landed cost participates in variance analytics.
6. **Vendor portal exposure** — before P5 vendor-portal ack UI, add an explicit RLS re-audit hop (subset of P13) so vendor-scoped users cannot leak sibling POs. Do not defer to P13.

No phases dropped. Order preserved.

## Phase 3 — Execution order (pickup)

Resume exactly where the plan says: **UI catch-up for P1/P2/P3**, then P4 backend.

### Batch A — Supplier 360 workbench (P1-UI)
- Route: `src/apps/purchases/pages/suppliers/` (list + record). Add nav entry under "Vendors".
- Record tabs: Identity, Qualification timeline, Compliance, Bank accounts, Contracts (reads P2), Requisitions (reads P3), PO/GR/Bill/Payment history, Scorecard placeholder.
- Wire 5 supplier RPCs (`submit/approve/reject_supplier_qualification`, `suspend/reinstate_supplier`).
- Uses `useDocumentRecord` pattern (already in `src/features/purchases/orders/usePurchaseOrderRecord.ts`).

### Batch B — Contracts workbench (P2-UI)
- Route: `src/apps/purchases/pages/contracts/` (list + record).
- Record shows header, lines with utilization bars, releases ledger, transitions calling the 4 contract RPCs.
- Includes the ceiling-trigger smoke assertion described in Phase 2 amendment 2.

### Batch C — Requisitions workbench (P3-UI)
- Route: `src/apps/purchases/pages/requisitions/` (requester form + buyer inbox).
- Wire 4 requisition RPCs. Buyer inbox filters `status='approved'` awaiting sourcing.
- Registers SoD conflict `requester ≠ approver` in `governance_sod_conflicts` at RPC-call sites.

### Batch D — P4 Sourcing supertype (backend)
- `sourcing_events { kind: rfi|rfq|rfp|auction }`, `sourcing_scoring_criteria`, `sourcing_vendor_scores`, sealed-bid `opens_at`, award justification.
- Extend `rfqs` non-destructively with `sourcing_event_id` FK.
- `award_sourcing_event_atomic` — respects P2 ceilings and stamps `purchase_orders.requisition_id` when seeded from a requisition. Emits `sourcing.event.*`. Phase-close smoke asserts award emission.

### Batches E → M — P5 → P13
Executed in the exact order in the shipped plan (PO lifecycle → ASN → GR reconstruction → Match → Returns/credit → Scorecards → Workbench UX consolidation → Playwright `procurement` project → RLS/SoD re-audit). Every phase honors the guardrails already declared in the plan (canonical wrapper, no direct stock/finance writes, GRANT-before-RLS-before-POLICY, self-approval blocked, outbox with `<topic>:<entity>:<state>` idempotency).

## Technical guardrails carried every phase

- Procurement never writes `stock_quants` / `stock_movements` / `cost_layers` / `journal_entries` / `journal_entry_lines` — enforced by `src/test/architecture/procurement.test.ts`.
- Every new `public.*` table: `CREATE TABLE` → `GRANT` (authenticated DML, service_role ALL, anon denied) → `ENABLE RLS` → `CREATE POLICY`, in the same migration.
- Every lifecycle RPC: `SECURITY DEFINER`, `SET search_path = public`, scoped via `user_has_business_access`, atomic, self-approval blocked, outbox emit with deterministic idempotency key.
- No CRUD page retired until the workbench replaces it AND `e2e/procurement/*` covers the flow.

## Deliverable of the next build turn

Batch A — Supplier 360 workbench wired to the 5 shipped supplier RPCs, with list + record pages, nav entry, and a real end-to-end submit→approve flow that produces the first `supplier.qualification_*` outbox rows this project has ever seen.
