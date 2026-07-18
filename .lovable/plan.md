
## Phase 1 — Verification of previous engineer's work

I audited `.lovable/plan.md` (the inherited implementation log) against the live DB and repo. Prior-engineer claims for Batches A/B/C, C-Verify, and D were re-checked with `pg_proc`, `information_schema`, `governance_*` queries and file reads. Findings:

| Claim | Evidence | Verdict |
|---|---|---|
| Batches A/B/C (Suppliers, Contracts, Requisitions workbenches + RPCs) | Files present under `src/features/purchases/{suppliers,contracts,requisitions}`, RPCs in `pg_proc`, nav wired | Genuinely shipped structurally |
| Batch C-Verify — outbox `source` allowlist widened, idempotency unique constraint, requisition line status `'open'`, 5 duties + 6 SoD conflicts registered | All four fixes verified live in DB | Landed correctly |
| Batch D — Sourcing supertype (P4) | 4 tables (`sourcing_events`, `sourcing_scoring_criteria`, `sourcing_vendor_scores`, `sourcing_event_awards`) + 7 RPCs (`create/open/score/close/award/_emit_sourcing_outbox/get_next_sourcing_event_number`) + `rfqs.sourcing_event_id` FK + `sourcing.close` duty + SoD `sourcing.award ≠ sourcing.close` and `≠ sourcing.create` all present | Landed correctly at the SQL layer |
| Batch D-Verify runtime smoke | Not in `supabase/migrations/`; sourcing tables have 0 rows | **Not landed — this is the current blocker** |
| Batches D.5 through M (preferred suppliers, PO lifecycle, ASN, GR reconstruction, 3/4-way match, returns, scorecards, UI, e2e, RLS re-audit) | No tables/RPCs/files | Not started (matches plan) |

Verdict: prior work up through Batch D is real and consistent with enterprise-grade guardrails (SECURITY DEFINER + `user_has_business_access` + self-approval blocks + outbox emit with `<event_type>:<entity>:<state>` idempotency). The only regression vs the plan's own rules is the missing Batch D phase-close smoke.

## Phase 2 — Plan validation & amendments

The inherited plan (Batches D-Verify → M, with technical guardrails at the bottom of `.lovable/plan.md`) is architecturally sound. I keep it and add:

1. Batch D-Verify smoke MUST also assert `procurement_contracts.utilized_value` incremented by the awarded amount, and MUST attempt an over-ceiling award and confirm rejection (contract-ceiling breach is currently only exercised via `award_sourcing_event_atomic`, so this is the only place it gets runtime coverage before Batch E).
2. Batch D.5 (`supplier_item_terms`) must include a UNIQUE `(business_id, product_id, supplier_id, effective_from)` and a validation trigger enforcing `effective_from < COALESCE(effective_to, 'infinity')` and price-break tier monotonicity (do not use CHECK for date/tier validation — validation triggers per the codebase convention).
3. Batch D.5 must also register a governance duty `supplier_terms.manage` and add SoD `supplier_terms.manage ≠ po.approve` so buyers cannot both set preferred rank/price and approve the resulting PO.
4. Nothing else changes; Batches E through M inherit unchanged from `.lovable/plan.md` including the guardrails on separation from Inventory/Warehouse/Finance mutations.

## Phase 3 — Execution order (resume point)

### Step 1 — Batch D-Verify smoke (blocking, first)
Land one migration `supabase/migrations/<ts>_procurement_batch_d_verify_smoke.sql`:

- Wrap in `DO $$ ... $$` with `RAISE EXCEPTION '__SMOKE_ROLLBACK_MARKER__'` at the end so the whole run rolls back cleanly (matches the Batch C-Verify pattern already in the repo).
- Spoof two users via `set_config('request.jwt.claim.sub', user_a/b, true)` seeded in `user_business_access` for a scratch business.
- Seed prerequisites using verified table shapes: `contacts(type='supplier', supplier_rank=1)` → `suppliers(contact_id, supplier_code, lifecycle_state='approved')` → `procurement_contracts(kind='blanket', status='active', ceiling_value=100000, created_by=user_a, approved_by=user_b, approved_at=now())`.
- Drive lifecycle as user_a: `create_sourcing_event` → `open_sourcing_event` (after inserting scoring criteria summing to 100) → `score_sourcing_vendor`.
- Assert `close_sourcing_event` **rejects** when called by user_a (self-close SoD) and **succeeds** as user_b.
- Assert `award_sourcing_event_atomic` **rejects** an award > ceiling (150k on a 100k contract) with the ceiling-breach error, then **succeeds** at 50k as a different eligible user.
- Assert `procurement_contracts.utilized_value` = 50000 post-award.
- Assert ≥4 `business_event_outbox` rows with `event_type IN ('procurement.sourcing.created','opened','closed','awarded')` and idempotency keys of the shape `<event_type>:<entity_id>:<state>`.

Only when the migration applies cleanly (rolling back at the marker) is Batch D signed off.

### Step 2 — Batch D.5: Preferred suppliers & lead times

Migration adding:
- `supplier_item_terms(id, business_id, product_id, supplier_id, preferred_rank, lead_time_days, min_order_qty, price_break_tiers jsonb, currency_code, effective_from, effective_to, created_by, updated_by, created_at, updated_at)` with the standard GRANT → RLS → policies quartet.
- Unique `(business_id, product_id, supplier_id, effective_from)`.
- Validation trigger `_validate_supplier_item_terms` enforcing effective-date order, tier monotonicity, and non-negative numerics.
- `updated_at` trigger.
- Governance: `supplier_terms.manage` duty + SoD `supplier_terms.manage ≠ po.approve` (alphabetical `duty_a < duty_b`).
- No new RPC yet — Batch E consumes the table for PO defaulting.
- Phase-close smoke migration exercising insert / update / effective-window overlap rejection, wrapped in the rollback marker.

### Step 3 and beyond — unchanged from `.lovable/plan.md`

Batches E (P5 PO lifecycle + revisions + acknowledgement), F (P6 ASN / expected delivery), G (P7 GR reconstruction with canonical-writer arch guard extension), H (P8 3-/4-way match with `bill_match_results.landed_cost_bill_id`), I (P9 returns + supplier credit notes), J (P10 scorecards), K (UI workbenches on top of the shipped RPCs + retire "Vendors (legacy)"), L (P12 Playwright `procurement` project), M (P13 final RLS/SoD re-audit + `docs/audit/procurement-verdict.md`). Guardrails at the bottom of `.lovable/plan.md` (Procurement never writes inventory/finance ledger tables; approvals ride the shared `approval_workflows`; outbox idempotency `<event>:<entity>:<state>`; canonical writer arch tests) apply to every batch.

### Technical details

- Every new public table: CREATE → GRANT (`authenticated` DML, `service_role` ALL, `anon` denied) → ENABLE RLS → POLICY, in the same migration.
- Every lifecycle RPC: `SECURITY DEFINER`, `SET search_path = public`, scoped via `user_has_business_access` + `user_can_access_branch`, atomic, self-approval blocked, direct outbox insert with `source='procurement'` (whitelist widening is out of scope for procurement).
- Update `src/test/architecture/procurement.test.ts` in Batch G to forbid non-canonical `INSERT INTO goods_receipts(_items)` writers.

### Deliverable at end of this turn

Only Step 1 (Batch D-Verify smoke migration) plus any follow-up fixes it uncovers. Step 2 (Batch D.5) starts in the next turn once D-Verify is green — per the plan's own "no phase advances without a green smoke" rule.

---

## Execution log

### Batch D-Verify ✅ LANDED (2026-07-18)

Smoke migration applied and rolled back cleanly via `__SMOKE_ROLLBACK_MARKER__`. Drove create → open → score → self-close reject → close (user_b) → over-ceiling award reject → valid 50k award. Asserted:
- `procurement_contracts.utilized_value` == 50000 post-valid-award and == 0 after the failed over-ceiling attempt.
- ≥4 outbox rows for the event covering `procurement.sourcing.{created,opened,closed,awarded}`.
- Awarded outbox idempotency key matches `procurement.sourcing.awarded:<event_id>:awarded`.
- Reused Batch C-Verify fixtures (org, biz, user_a, user_b).

**Non-obvious fix folded into the smoke** (apply to every future smoke):
- `sourcing_events` has CHECK `closes_at > opens_at`, and `now()` is transaction-frozen inside a `DO` block. Pre-seed `opens_at = now() - interval '1 minute'` at create time so close's `COALESCE(closes_at, now())` still satisfies the constraint.
- Expected-failure assertions live in inner `BEGIN … EXCEPTION WHEN OTHERS` blocks matching `SQLERRM ILIKE '%…%'`, so the outer smoke rollback handler doesn't swallow them.

### Next pickup — Batch D.5 (Preferred suppliers & lead times)

Spec unchanged from Step 2 above. Land the `supplier_item_terms` migration + phase-close smoke (insert / update / effective-window overlap rejection) before any Batch E work.

### Batch D.5 ✅ LANDED (2026-07-18)

`supplier_item_terms` table with GRANT/RLS/policies, validation trigger for date/tier/overlap, `supplier_terms.manage` duty and SoD vs `po.approve`. Smoke asserted insert/update happy path and effective-window overlap rejection.

### Batch E ✅ LANDED (2026-07-18)

PO lifecycle. `po_status` extended with `submitted, approved, acknowledged, closed, revised, rejected`. Added `purchase_order_revisions` and RPCs `submit / approve / reject / acknowledge / revise / cancel / close_purchase_order`. Registered duties `po.{submit,approve,reject,acknowledge,revise,close}` and 5 SoD rules (self-approval, creator≠approver, approver≠ack, etc.). Outbox emits `procurement.po.<state>` with deterministic idempotency keys.

Non-obvious fixes folded in during smoke bring-up (keep for future batches):
- Enum extension broke pre-existing text-typed helpers. `guard_purchase_order_self_approval` and `tg_purchase_order_contract_ceiling` were casting `NEW.status` implicitly — patched to `NEW.status::text` on both sides.
- `sync_recommendation_from_po` referenced enum literal `'completed'` which is not in `po_status`; dropped it and switched to `::text` compare.
- Original `_emit_po_outbox` helper used columns `business_id` / `entity_id` that do not exist on `business_event_outbox` (real columns are `org_id`, `source_doc_type`, `source_doc_id`, `source`). Helper rewritten and now derives `org_id` from `purchase_orders`.
- Smoke reuses two real users from `user_business_access` (FK to `auth.users` is enforced); do not fabricate UUIDs.

### Batch F ✅ LANDED (2026-07-18)

ASN / inbound shipment lifecycle. Added `_validate_inbound_shipment_item` trigger (positive qty, org/business match, expiry ≥ manufacture), `_emit_asn_outbox` helper, and RPCs `create_inbound_shipment`, `dispatch_inbound_shipment`, `mark_inbound_shipment_in_transit`, `mark_inbound_shipment_arrived`, `cancel_inbound_shipment`, `update_inbound_shipment_eta`. Duty `asn.manage` + SoD vs `po.approve` and `po.receive`. Smoke walked draft→dispatched→in_transit→arrived plus cancel and terminal-guard rejection.

### Next pickup — Batch G (P7 GR reconstruction)

Rebuild goods-receipt authoring on canonical writers. Extend `src/test/architecture/procurement.test.ts` to forbid non-canonical `INSERT INTO goods_receipts(_items)` writers. RPCs: `receive_inbound_shipment(shipment_id, lines[])` → creates `goods_receipts` + `goods_receipt_items`, flips `inbound_shipments.status='received'` and PO line received quantities. Emit `procurement.grn.<state>`. Register `grn.receive` duty (may already exist as `po.receive`) + SoD `grn.receive ≠ po.approve` + `grn.receive ≠ asn.manage` (latter is done). Smoke: partial receipt, over-receipt rejection, idempotent replay.

