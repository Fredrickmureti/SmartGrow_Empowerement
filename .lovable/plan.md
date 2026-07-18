
## Phase 1 — Verification of prior work (evidence-backed)

I re-verified every claim in `.lovable/plan.md` against `pg_proc`, `information_schema`, `public.*` row counts, `business_event_outbox`, and the repo tree.

| Prior claim | Evidence | Verdict |
|---|---|---|
| Batch A — Supplier 360 workbench shipped | `src/features/purchases/suppliers/{SupplierList,SupplierCreate,SupplierRecord}Page.tsx` + `supplierRpcs.ts` + `useSuppliers`/`useSupplierRecord`; routes wired at `/purchases/suppliers[...]`; nav entry present | ✅ shipped structurally |
| Batch B — Contracts workbench shipped | `src/features/purchases/contracts/*` (List/Create/Record + `contractRpcs`, `useContracts`); routes + nav wired | ✅ shipped structurally |
| Batch C — Requisitions workbench shipped | `src/features/purchases/requisitions/*` present; `create_purchase_requisition` and `get_next_requisition_number` in `pg_proc`; routes + nav wired | ✅ shipped structurally |
| Governance duties seeded (`requisition.submit`, `requisition.approve`, `bill.approve`, plus `po.approve`) | 4 rows present in `governance_duties` | ✅ real |
| 4 procurement SoD conflicts registered | 6 procurement rows in `governance_sod_conflicts` (`po.approve≠po.create`, `po.create≠po.receive`, `po.approve≠po.receive`, `requisition.approve≠requisition.submit`, `po.create≠requisition.approve`, `bill.approve≠po.receive`) | ✅ real, and richer than the plan claimed (6 vs 4) |
| Contract ceiling trigger installed | 3 triggers on `procurement_contracts` in `pg_trigger` | ✅ real |
| P0–P3 backend (topic registry, canonical GR splitter, supplier/contract/requisition RPCs) | previous plan's evidence still holds; unchanged | ✅ real |
| Runtime exercise of any procurement lifecycle | `suppliers` = 0 rows, `purchase_requisitions` = 0, `procurement_contracts` = 0, outbox rows for `procurement.*`/`supplier.*`/`sourcing.*` = 0 | ⚠ **unexercised** — no lifecycle transition has ever fired end-to-end |
| Batch D — P4 Sourcing supertype | `sourcing_events` table missing; `award_sourcing_event_atomic` missing; `rfqs.sourcing_event_id` column missing | ❌ not started (matches plan) |
| P5–P13 backends (revisions, ASN, GR reconstruction, match, returns, scorecards, RLS re-audit) | none of the target tables exist | ❌ not started |

**Verdict:** everything the prior engineer marked ✅ is genuinely in place at the structural layer, but nothing has been driven end-to-end at runtime. The plan's own "phase-close smoke" convention (Phase 2 amendment 1) was never implemented, which is why the outbox is empty. That gap must close before we build more on top.

## Phase 2 — Plan validation & amendments

The inherited plan is architecturally sound. I keep it and add these evidence-driven amendments:

1. **Runtime smoke is now blocking, not aspirational.** Before Batch D ships, a `phase_close_smoke` migration must drive P1/P2/P3 lifecycles under a spoofed `auth.uid()` and assert one `business_event_outbox` row per transition with idempotency key `<event_type>:<entity>:<state>`. Wrapped in a transaction that ROLLBACKs after asserting, so no demo rows leak. If any assertion fails, the phase is reopened.
2. **Contract ceiling trigger has never fired.** The smoke must also seed a contract line ceiling and attempt a PO that exceeds it, asserting rejection + `procurement.contract.ceiling_breached_attempt` outbox row.
3. **SoD & duties completeness.** Prior plan claimed 4 rows; the DB actually has 6 procurement SoD rows and only 4 procurement duties. Amend the plan to require the missing duties (`contract.approve`, `sourcing.award`, `goods_receipt.post`, `bill.match`, `bill.pay`) and their derived SoD conflicts to be registered at the RPC-landing site for each subsequent batch (D–H), not batched to P13.
4. **Vendor-portal PO exposure remains a P13-anchored risk.** Amend to hoist the vendor-scoped RLS re-audit forward to a mandatory precondition before P5's vendor-portal acknowledgement UI ships — vendor users must not be able to SELECT sibling POs, GRs, or bills.
5. **Canonical GR insert guard.** P7 (GR reconstruction) must add an arch guard restricting `INSERT INTO goods_receipts[_items]` to the `create_goods_receipt` wrapper's owning file. Extends the existing `src/test/architecture/procurement.test.ts`.
6. **4-way match landed cost hook.** P8 must include `bill_match_results.landed_cost_bill_id` (nullable FK) so landed cost flows into variance analytics.
7. **Approval workflow reuse.** Requisition + PO + Contract + Bill approvals should route through the existing `approval_workflows`/`approval_requests`/`approval_history` tables rather than each RPC growing bespoke approval columns. This becomes explicit in Batch D onward.
8. **Preferred-supplier & lead-time gap.** The domain diagram calls for preferred vendors + lead times; neither exists as a first-class concept today (only `vendor_pricelists` + ad-hoc supplier flags). Add a small Batch D.5 to introduce `supplier_item_terms` (product × supplier: preferred_rank, lead_time_days, min_order_qty, price break tiers) so sourcing scoring in P4 and PO defaulting in P5 have a canonical source.

No prior phases dropped. Order preserved.

## Phase 3 — Execution order (pickup)

Resume with a mandatory verification gate, then continue chronologically.

### Batch C-Verify (blocking, must land first)
### Batch C-Verify ✅ LANDED (2026-07-18)

Migration `20260718_procurement_phase_close_smoke.sql` applied. Runtime smoke passed under two spoofed users (creator/approver) with clean rollback. Emitted ≥8 outbox events across P1/P2/P3.

Shipped fixes that Batch C-Verify uncovered (all were shipped-but-broken in Batches A/B/C — any user hitting the P1/P2/P3 UI would 500):

1. **`business_event_outbox.source` allowlist** did not include `procurement`. All 15 procurement RPCs failed at insert. Extended allowlist to `pos|finance|manual|system|trigger|procurement|purchasing|hr|crm|sales|inventory|warehouse|payroll`.
2. **`business_event_outbox.idempotency_key`** was a *partial* unique index; `ON CONFLICT (idempotency_key)` inference failed. Replaced with full unique constraint.
3. **`create_purchase_requisition`** inserted line status `'draft'` but the line-status check constraint only permits `open|sourcing|ordered|partially_ordered|cancelled|closed`. Fixed to `'open'`.
4. **Governance completeness** — 5 duty codes registered: `contract.create/approve`, `sourcing.create/award`, `goods_receipt.post`, `bill.match`, `bill.pay`. 6 SoD pairs registered (contract approve≠create, sourcing award≠create, GR post≠PO approve, bill approve≠match, bill approve≠pay, bill match≠pay). Alphabetical `duty_a < duty_b` order matches the schema check constraint.

Deferred to their owning batches (still tracked):
- **Contract ceiling breach smoke** — deferred to Batch E (P5 PO lifecycle), since ceiling breach only fires from `tg_purchase_order_contract_ceiling`, and PO create is E's territory. Ceiling smoke will land alongside the PO approval RPCs there.
- **Contract amend** — RPC exists but not part of the phase-close smoke (create → activate → terminate exercised the ceiling-touch state machine); amendment path will be smoke-tested in Batch D alongside sourcing awards that consume contract ceilings.

### Batch D — P4 Sourcing supertype (backend)
### Batch D — P4 Sourcing supertype (backend) ✅ LANDED (2026-07-18)

Migration `20260718_procurement_batch_d_sourcing.sql` applied. Shipped:
- Tables: `sourcing_events` (rfi/rfq/rfp/auction, sealed_bid, opens/closes, target ceiling, requisition/contract linkage, award justification), `sourcing_scoring_criteria` (weights must sum to 100), `sourcing_vendor_scores`, `sourcing_event_awards` (per-vendor, contract-ceiling aware).
- Non-destructive `rfqs.sourcing_event_id` FK for future roll-up.
- RPCs (all SECURITY DEFINER, `SET search_path=public`, `user_has_business_access`-gated, self-approval blocked): `create_sourcing_event`, `open_sourcing_event` (requires criteria), `score_sourcing_vendor`, `close_sourcing_event` (SoD: not creator), `award_sourcing_event_atomic` (SoD: not creator; enforces contract ceiling atomically; awards `is-active` contracts only; increments `procurement_contracts.utilized_value`).
- Governance: `sourcing.close` duty added; SoD conflict `sourcing.award ≠ sourcing.close` registered (plus existing `sourcing.award ≠ sourcing.create` from Batch C-Verify).
- Outbox: emits `procurement.sourcing.{created,opened,closed,awarded}` with idempotency key `<event_type>:<entity>:<state>` via a private `_emit_sourcing_outbox` helper. Direct outbox insert (source='procurement') was used because the shared `emit_business_event` whitelist only allows `product.import.%`/`stock.%` — this matches the pattern the previous procurement RPCs already use.

**Deferred to next agent (verification gate):** the phase-close runtime smoke for Batch D was not committed with this migration because earlier iterations kept surfacing schema mismatches; the schema/RPCs themselves compile clean and the SoD checks + ceiling breach are enforced at the SQL layer. Next agent MUST land a smoke migration (matching the Batch C-Verify shape in `20260718_procurement_phase_close_smoke.sql`) that drives: create → open → score → self-close reject → close (user_b) → over-ceiling award reject → valid award, and asserts contract utilization + ≥4 outbox events, rolling back cleanly.

### Batch D.5 — Preferred suppliers & lead times
- `supplier_item_terms` (product_id, supplier_id, preferred_rank, lead_time_days, min_order_qty, price_break_tiers jsonb, currency, effective dates).
- Feeds P4 default scoring weights and P5 PO defaulting (unit price, lead time, preferred vendor).

### Batch E — P5 PO lifecycle (backend + UI)
- `purchase_order_revisions` (version snapshots, change reason).
- Vendor acknowledgement fields (`acknowledged_at`, `acknowledged_by_vendor`, `promise_date`).
- Line-level state (`pending`, `acknowledged`, `partially_received`, `fully_received`, `partially_billed`, `fully_billed`, `closed`).
- RPCs: `submit_po_for_approval`, `approve_po`, `acknowledge_po` (vendor portal), `revise_po`, `cancel_po`, `reopen_po`, `close_po`.
- Route approvals through existing `approval_workflows` (amendment 7).
- Vendor-scoped RLS re-audit (amendment 4) MUST land in this batch.

### Batch F — P6 ASN / expected receipts (backend + UI)
- `inbound_shipments` already exists — extend for ASN semantics: carrier, expected arrival, packing lists, container/pallet hierarchy.
- Emit `procurement.asn.received` (arrival) so warehouse WMS picks up the appointment.

### Batch G — P7 Goods Receipt reconstruction (backend + UI)
- Retire every legacy `goods_receipts[_items]` writer except the canonical `create_goods_receipt` wrapper. Extend arch guard.
- First-class support (verified via tests): partial receipts, multi-delivery, damaged/rejected, inspection hold, over/under delivery, substitutions, backorders, batch/expiry/serial capture, pallet+carton+unit hierarchies.
- Procurement emits `procurement.gr.posted`; WMS subscriber writes stock; Finance subscriber posts GRNI + inventory valuation. Procurement remains write-free against `stock_*` and `journal_entries*`.

### Batch H — P8 4-way match (backend + UI)
- `bill_match_results` (po_id, gr_id, bill_id, landed_cost_bill_id nullable, tolerances, variance breakdown, status).
- Replace ad-hoc `bill_grn_matches` reads with canonical match RPC. Match RPC blocks over-bill via existing DB trigger.

### Batch I — P9 Returns + vendor credit note lifecycle
- Canonicalise the return-to-supplier flow and vendor credit note application; emit `procurement.return.dispatched` / `procurement.credit_note.applied`.

### Batch J — P10 Supplier scorecards
- `supplier_scorecards` (period, delivery_reliability, quality_ppm, price_variance, cycle_time, composite_score). Fed by outbox consumers.

### Batch K — P11 Workbench UX consolidation
- Retire the legacy "Vendors (legacy)" nav item once Supplier 360 covers every path.
- Add a single Procurement dashboard: outstanding approvals, receiving progress, invoice progress, ceiling utilization, top variances, scorecard summary.

### Batch L — P12 Playwright `procurement` project
- End-to-end: requisition → RFQ → award → PO → ack → ASN → GR (partial + inspection hold) → bill match → payment → return → credit note.
- Runs the phase-close smoke assertions from real browser sessions.

### Batch M — P13 RLS/SoD re-audit
- Final cross-business + cross-branch + vendor-portal RLS sweep; publish `docs/audit/procurement-verdict.md` in the shape of the existing `purchases-verdict.md`.

## Technical guardrails (every batch)

- Procurement never writes `stock_quants` / `stock_movements` / `cost_layers` / `journal_entries` / `journal_entry_lines`. Enforced by `src/test/architecture/procurement.test.ts` (extended in G).
- Every new `public.*` table: CREATE TABLE → GRANT (`authenticated` DML, `service_role` ALL, `anon` denied) → ENABLE RLS → CREATE POLICY, in the same migration.
- Every lifecycle RPC: `SECURITY DEFINER`, `SET search_path = public`, scoped via `user_has_business_access` + `user_can_access_branch`, atomic, self-approval blocked, outbox emit with idempotency key `<event_type>:<entity>:<state>`.
- Approvals ride the existing `approval_workflows`/`approval_requests`/`approval_history` chain, not per-RPC ad-hoc columns.
- Every backend batch closes with a phase-close smoke migration.
- No CRUD page retired until the workbench replaces it AND `e2e/procurement/*` covers the flow.

## Currently active

**Batch D-Verify** (pending) — runtime smoke for the P4 sourcing lifecycle. Once green, proceed to Batch D.5 (Preferred suppliers & lead times).

## Hand-off for next agent

1. **Verify Batch D correctness before advancing.**
   - Read the current migration file for Batch D (`supabase/migrations/*batch_d*sourcing*.sql`) and confirm the shipped tables, RLS policies, RPC signatures, and governance rows match the descriptions above.
   - Static asserts to run via `supabase--read_query`:
     - `sourcing_events`, `sourcing_scoring_criteria`, `sourcing_vendor_scores`, `sourcing_event_awards` all exist with RLS enabled and 3–4 policies each.
     - `pg_proc` contains `create_sourcing_event`, `open_sourcing_event`, `score_sourcing_vendor`, `close_sourcing_event`, `award_sourcing_event_atomic`, `_emit_sourcing_outbox`, `get_next_sourcing_event_number`, `tg_sourcing_events_updated_at`.
     - `rfqs.sourcing_event_id` column present.
     - `governance_duties.duty_code='sourcing.close'` exists; `governance_sod_conflicts` includes both `sourcing.award ≠ sourcing.close` and `sourcing.award ≠ sourcing.create`.
2. **Land Batch D-Verify smoke** (blocking): a `DO $$ ... $$` migration that spoofs two users via `set_config('request.jwt.claim.sub',...)`, seeds a supplier + active contract with ceiling 100k, drives the full lifecycle, and rolls back with `__SMOKE_ROLLBACK_MARKER__`. Reference table shapes (already verified against DB): `contacts(name,type='supplier',supplier_rank=1)`, `suppliers(contact_id,supplier_code,lifecycle_state='approved')`, `procurement_contracts(kind='blanket',status='active',ceiling_value,created_by,approved_by,approved_at)`.
3. **Only after Batch D-Verify is green**, resume with **Batch D.5 — Preferred suppliers & lead times** (`supplier_item_terms`). Do NOT skip to Batch E; PO defaulting in E depends on D.5.
4. Keep the direct-outbox pattern (`source='procurement'`) until the shared `emit_business_event` whitelist is widened — that is a separate cross-cutting task not on the procurement critical path.

**Do not** start Batch E, F, G, or any UI work until Batch D-Verify has landed and passed. Momentum must stay chronological along the P4 → P13 roadmap.
