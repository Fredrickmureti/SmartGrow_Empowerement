
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
