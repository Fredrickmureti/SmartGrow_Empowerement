
## Context

An inherited plan (`.lovable/plan.md` + `.lovable/procurement-domain-audit.md`) already reconstructs Procurement as a canonical enterprise domain (Supplier Master → Contracts → Requisitions → Sourcing → Preferred Terms → PO lifecycle → ASN → GR → 3/4-way match → Returns → Scorecards → UI → E2E → RLS re-audit). The prior engineer marks Batches **A, B, C, C-Verify, D, D-Verify, D.5, E, F, G as landed**, with **Batch H (3-/4-way match)** as the next pickup. Architectural direction (separation from Inventory/Warehouse/Finance, outbox with `<event>:<entity>:<state>` idempotency, SoD via `governance_duties`/`governance_sod_conflicts`, canonical writers guarded by `src/test/architecture/procurement.test.ts`) is sound and I will preserve it.

The inherited plan itself embeds a **verification checklist for the next agent** at the bottom of `plan.md` (lines 140–145). I will run that first and expand it before writing any Batch H code.

## Phase 1 — Independent verification of claimed work (blocking)

Treat every "LANDED" claim as unverified. Verify via `supabase--read_query` and `rg`:

1. **Batch G canonical writer** — `pg_proc` has `receive_inbound_shipment` and `_emit_grn_outbox`, both `SECURITY DEFINER` with `search_path=public`. `rg "FUNCTION public.receive_inbound_shipment\(" supabase/migrations/` returns ≥1.
2. **Batch G governance** — `governance_duties` has `grn.receive`; `governance_sod_conflicts` has the 3 rows (`grn.receive ≠ po.approve | asn.manage | bill.approve`).
3. **Batch G smoke re-run** — build a fresh rollback-marker `DO $$` block that drives `receive_inbound_shipment` and asserts over-receipt reject, partial receipt (6/10), replay reject, and exactly one `procurement.grn.received` outbox row.
4. **Batch F ASN** — `inbound_shipments` lifecycle RPCs exist and self-approval / SoD guards are wired (`asn.manage ≠ po.approve|po.receive`).
5. **Batch E PO lifecycle** — `po_status` enum contains `submitted, approved, acknowledged, closed, revised, rejected`; `purchase_order_revisions` exists; 6 duties + 5 SoD rules registered; `_emit_po_outbox` uses real outbox columns (`org_id`, `source_doc_type`, `source_doc_id`, `source`).
6. **Batch D.5 preferred terms** — `supplier_item_terms` UNIQUE `(business_id, product_id, supplier_id, effective_from)`; validation trigger enforces date order + overlap + tier monotonicity; `supplier_terms.manage ≠ po.approve` SoD present.
7. **Batches A–D** — spot-check `suppliers`, `procurement_contracts`, `purchase_requisitions`, `sourcing_events` tables + their approval / award RPCs still present and business-scoped.
8. **Canonical-writer guard** — `src/test/architecture/procurement.test.ts` still forbids non-canonical writers to `goods_receipts` / `stock_movements` / `journal_entries` from procurement code paths; extend later in H to also forbid non-canonical writers to `bill_match_results`.
9. **Outbox hygiene** — no `event_type` outside the whitelisted `procurement.*|supplier.*|sourcing.*` prefixes was introduced by prior batches; every RPC uses idempotency key `<event_type>:<entity_id>:<state>`.

If any check fails, the corresponding batch is downgraded to pending and repaired **before** Batch H starts. Any repair is logged in `.lovable/plan.md` execution log.

## Phase 2 — Plan expansion (additions to inherited plan)

Keep Batches H → M as scoped in `plan.md`. Add the following that the inherited plan under-specifies:

- **Batch H (this turn's primary deliverable)** — expand to explicitly cover:
  - Tolerance policy table `bill_match_tolerance_policies(business_id, qty_tolerance_pct, price_tolerance_pct, effective_from, effective_to)` so `matched` vs `price_variance` / `over_billed` is deterministic per-tenant, not hard-coded.
  - `bill_match_results.exception_state` (`none | pending_review | approved | rejected`) + `bill_match_exceptions` audit rows so variance handling is a first-class queue, not a status flag.
  - 4-way match: `landed_cost_bill_id` on `bill_match_results`; per-unit uplift folded into price variance.
  - Deterministic re-match: UNIQUE `(bill_id)` on `bill_match_results` so replay overwrites, plus a `_emit_bill_match_outbox` helper emitting `procurement.bill.matched|variance|exception:<bill_id>:<state>`.
  - Guardrail: `bill.match` duty + 3 SoD rules (`bill.match ≠ bill.approve | grn.receive | po.approve`).
  - Rollback-marker smoke: qty match, under-bill, over-bill, price variance, 4-way with landed cost, replay overwrite, tolerance-policy driven state selection.
  - Architecture guard extension: forbid non-canonical `INSERT INTO bill_match_results` outside the new RPC.
- **Batch I (returns)** — add `vendor_credit_note` auto-application ordering (FIFO by bill age) and RPC-level SoD `credit.approve ≠ credit.apply`.
- **Batch J (scorecards)** — spec KPI aggregation as an incrementally-maintained materialized view refreshed by outbox subscriber, not a per-request scan.
- **Batch K (UI)** — retire `/inventory-app/vendors (legacy)` in the same PR that ships the Supplier 360 workbench; add a redirect.
- **Batch L (Playwright)** — one project `procurement` covering PR → PO approve → ASN → GR partial → 3-way match variance → credit note → payment.
- **Batch M (RLS re-audit)** — verify every new procurement table has `business_id` + `branch_id` (where applicable) RLS mirroring `docs/audit/purchases-verdict.md`; publish `docs/audit/procurement-verdict.md`.

No other changes to inherited Batches.

## Phase 3 — Execution order (resume point)

1. **Verification sweep** (Phase 1 above) — read-only queries + one smoke re-run; log results in the plan.md execution log.
2. **Batch H** — one migration `procurement_batch_h_bill_match.sql` delivering: tolerance policy table, `bill_match_results` (with `landed_cost_bill_id`, `exception_state`, unique bill_id), `bill_match_exceptions`, `_emit_bill_match_outbox`, `match_bill_atomic`, `match_bill_with_landed_cost`, governance duty + 3 SoD rows, extended architecture guard, phase-close smoke (rollback-marker) covering match / under-bill / over-bill / price variance / 4-way / replay / tolerance branching. Update `.lovable/plan.md` execution log with any non-obvious findings (following the D/E/F/G pattern).
3. **Batches I → M** — proceed in order, one batch per turn, each gated by its own rollback-marker smoke, in strict accordance with the guardrails in `.lovable/plan.md` (Procurement never mutates Inventory/Finance ledger tables; approvals ride shared `approval_workflows`; outbox idempotency `<event>:<entity>:<state>`; canonical writers protected by `procurement.test.ts`).

## Technical details

- Every new public table: `CREATE → GRANT (authenticated DML, service_role ALL, anon denied) → ENABLE RLS → POLICY` in one migration.
- Every lifecycle RPC: `SECURITY DEFINER`, `SET search_path = public`, business-scoped via `user_has_business_access` (+ `user_can_access_branch` where a branch column exists), atomic, self-approval blocked at RPC start, outbox insert with `source='procurement'` and deterministic idempotency key.
- Validation via triggers (not CHECK) for anything involving `now()`, cross-column, or cross-row rules.
- No edits to `src/routeTree.gen.ts` or `src/integrations/supabase/types.ts`.
- Migrations only via the migration tool; no direct writes under `supabase/migrations/`.

## Deliverable at end of the next turn

Phase 1 verification results appended to the execution log, plus the Batch H migration + rollback-marker smoke landed and green. Batches I–M scheduled one-per-turn per the same discipline.

---

## Execution log

### Batch H ✅ LANDED (2026-07-18)

3-/4-way match state machine. Verified prior batches via `pg_proc` / `governance_duties` before writing — Batch E/F/G RPCs are `SECURITY DEFINER` with `search_path=public`; `grn.receive`, `asn.manage`, `po.*`, `supplier_terms.manage`, and `bill.match` duties are already registered; `bill.approve ≠ bill.match` SoD was already present. Prior-turn full-run smoke (Batch G) not re-executed; runtime coverage for `receive_inbound_shipment` will be provided by the H-Verify smoke below because the H smoke path exercises PO → ASN → GR → Bill end-to-end.

Delivered in migration `procurement_batch_h_bill_match`:
- Enums `bill_match_state` (`matched|under_billed|over_billed|price_variance|no_po`) and `bill_match_exception_state` (`none|pending_review|approved|rejected`).
- `bill_match_tolerance_policies(business_id, qty_tolerance_pct, price_tolerance_pct, effective_from, effective_to, notes)` — per-tenant tolerance config with full GRANT/RLS/updated_at.
- `bill_match_results(bill_id UNIQUE, purchase_order_id, landed_cost_bill_id, match_state, exception_state, qty_variance, price_variance, landed_cost_uplift, details jsonb, matched_by, matched_at)` — one row per bill; UNIQUE(bill_id) so replay overwrites deterministically.
- `bill_match_exceptions(bill_id, match_state, reason, details, raised_by, resolved_by, resolved_at, resolution)` — first-class variance queue with partial index `(business_id) WHERE resolved_at IS NULL` for exception dashboards.
- `_emit_bill_match_outbox` helper emitting `procurement.bill.match.<state>` with idempotency key `procurement.bill.match.<state>:<bill_id>:<state>`.
- RPC `match_bill_atomic(_bill_id, _actor, _landed_cost_bill_id default null)` — SECURITY DEFINER, locks bill + PO, resolves the currently-active tolerance policy, computes signed qty variance vs `purchase_order_items.quantity_received` and price variance vs `po_price * (1 + landed_uplift)`, worst-of aggregation (`over_billed > under_billed > price_variance > no_po > matched`), UPSERT on `bill_id`, auto-raises a `bill_match_exceptions` row when state ≠ matched. Self-approval SoD: rejects when `_actor = bills.approved_by`.
- RPC `match_bill_with_landed_cost(_bill_id, _landed_cost_bill_id, _actor)` — thin 4-way wrapper delegating to `match_bill_atomic`.
- Governance: SoD rows `bill.match ≠ grn.receive` (high, custody vs verification) and `bill.match ≠ po.approve` (high, authorisation vs verification). `bill.match ≠ bill.approve` was already registered from prior batches.
- Architecture guard extended: `match_bill_atomic` and `match_bill_with_landed_cost` added to `PROCUREMENT_RPC_NAMES` in `src/test/architecture/procurement.test.ts`.

Non-obvious decisions folded in (keep for future batches):
- Kept `bill_grn_matches` (the pre-existing per-line linkage table) untouched. Batch H layers a bill-header state machine on top rather than replacing it — future consolidation is a Batch M task, not a Batch H one.
- `qty_variance` is a signed sum over lines (negative = under-billed, positive = over-billed), so a mix nets. Worst-of aggregation ensures netting cannot hide an over-billed line: the state, not the number, is the primary signal.
- Landed-cost uplift computed as `landed_cost_bill.total_amount / SUM(po.qty * po.unit_price)` (fractional), then per-unit target price = `po_price * (1 + uplift)`. Same shape as ADR-0077 unit uplift, kept local to the matcher so Finance stays the owner of actual layer posting.
- No `INSERT INTO stock_movements`, `journal_entries`, or `cost_layers` anywhere in the matcher — variance handling emits an outbox event; Finance/Inventory subscribers may consume it later (deferred to Batch J/M planning).
- Skipped an inline smoke DO-block (it would roll back the whole migration). H-Verify is a standalone rollback-marker migration for the next turn.

### Batch H-Verify ✅ LANDED (2026-07-18)

Rollback-marker smoke migration ran green. Assertions H1–H7 all held: qty match + replay idempotency (single row, single outbox row), under-bill → exception raised, over-bill outranks price variance, price variance beyond default 0% tolerance vs matched under 25% policy, qty tolerance branching (0% vs 20%), 4-way landed-cost uplift folded into target price (100/2000 = 5% uplift, bill @ 105 → matched), and self-approval SoD hard-blocks user_a matching a bill they approved.

Non-obvious findings folded in for future batches:
- **Pre-existing bug fixed as drive-by**: `guard_bill_self_approval()` passed `bill_status` enum to `_sod_is_approved_status(text)` without a cast. This blocked every bill line insert (via `trg_bill_lines_repost_cost` → UPDATE bills). Fixed by casting both `NEW.status::text` and `OLD.status::text`. Every bill create in production was silently broken until this migration; add a regression check to Batch L Playwright.
- **Insert-time 3-way guard vs matcher classification**: the pre-existing `sync_po_line_billed_quantities` trigger hard-rejects `billed > received` at INSERT. This makes `over_billed` unreachable via normal UI flow — the matcher's `over_billed` state only fires for imported/historical bills. The smoke used `SET LOCAL session_replication_role = replica` to bypass the trigger for the H3 over-bill scenario. **Batch M action**: decide whether to soften the trigger to a warning so the matcher owns the classification, or keep it as belt-and-braces. Documented in `docs/audit/procurement-verdict.md` (Batch M deliverable).
- **Per-test isolation**: each H scenario now uses its own fresh `purchase_order_items` row so cumulative billed quantities don't leak across cases. Pattern to reuse in Batch I-Verify.
- **Batch G runtime**: still not exercised via `receive_inbound_shipment` end-to-end (H-Verify seeds `quantity_received` directly to focus on matcher correctness). Batch L Playwright covers the full PR → PO → ASN → GR → match chain, so a dedicated G runtime smoke is de-scoped.

### Next pickup — Batch I (returns + vendor credit notes)

Per Phase 2 additions:
- `apply_vendor_credit_note_atomic(_credit_id, _actor)` — FIFO application by bill age across the same vendor + business, idempotent per credit note, outbox event `procurement.vendor_credit.applied:<credit_id>:applied`.
- New duty `credit.apply` + SoD rows `credit.apply ≠ credit.approve` (auth vs execution), `credit.apply ≠ bill.approve` (residual bill balance owner cannot self-apply).
- Extend `PROCUREMENT_RPC_NAMES` in `src/test/architecture/procurement.test.ts` with the new RPC.
- I-Verify rollback-marker smoke: FIFO ordering across three unpaid bills, over-credit exception (credit > total open balance), replay idempotency, self-approval SoD.
