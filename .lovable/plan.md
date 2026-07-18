# Project Implementation Roadmap — Authoritative Status

**Last updated:** 2026-07-18
**Maintainer note:** This file is the single source of truth for phase status. Update it at the end of every arc, not mid-flight.

---

## Roadmap at a glance

| # | Phase / Arc | Status | Verdict doc |
|---|---|---|---|
| 1 | Procurement (P2P) — Batches A–N | ✅ CLOSED (2026-07-18) | `docs/audit/procurement-verdict.md` |
| 2 | Warehouse Ownership & Domain Boundary — Batches W1–W7 | ✅ CLOSED (2026-07-18) | `docs/adr/0080-warehouse-master-data-ownership.md` |
| 3 | **Inventory Domain Audit & Reconstruction** | 🔜 **NEXT — not started** | — |
| 4 | Sales / Order-to-Cash Domain Audit | ⏸ Queued | — |
| 5 | Finance / GL Consolidation Audit | ⏸ Queued | — |
| 6 | Manufacturing hooks (backflush, subcontract) | ⏸ Queued | — |
| 7 | Supplier Portal 2.0 & Sourcing (auctions, weighted award) | ⏸ Queued | — |

Currently **active phase:** none — Phase 2 just closed. Next agent picks up Phase 3 after verification (see below).

---

## Phase 1 — Procurement (P2P) — CLOSED

Full verdict: `docs/audit/procurement-verdict.md`.

Highlights:
- 13 canonical `SECURITY DEFINER` RPCs, all SoD-guarded, all row-lock their aggregate.
- FIFO multi-bill Vendor Credit Note application (`apply_vendor_credit_note_atomic`) with outbox emission; legacy `apply_vendor_credit_atomic` dropped in the same migration.
- Governance duties (`credit.approve`, `credit.apply`) and SoD conflicts registered.
- ADR-0079 party-vs-role model enforced — zero `supplier_id` FKs on transactional docs.
- Batch N DB triggers enforce cross-table `business_id`/`branch_id` integrity on bills, POs, VCNs, bill payments, journal entries.
- Supplier 360 workbench absorbs legacy `/purchases/vendors` — Finance defaults + custom-fields panel wired via Contact party.

Guardrails (permanent): no client-side GL, no `supplier_id` on transactional docs, GRANTs required in same migration as CREATE TABLE, all cross-app writes via `business_event_outbox`.

## Phase 2 — Warehouse Ownership & Domain Boundary — CLOSED

Full verdict: `docs/adr/0080-warehouse-master-data-ownership.md`.

Highlights:
- Warehouse app is sole author of `warehouses` master data; Inventory is read-only consumer.
- Master-data pages moved from `src/pages/inventory/Warehouse*.tsx` → `src/pages/warehouse/`.
- Inventory `/inventory-app/warehouses[/*]` legacy paths preserved via `<Navigate replace>` deep-link parity.
- Inventory sidebar entry removed; all cross-app links repointed.
- Cycle-count contract formalised: WMS session (`wms_count_sessions`) executes → `warehouse.count.session.completed` event → Inventory (`physical_counts`) posts adjustments. Both surfaces link to each other.
- Architecture guard: `src/test/architecture/wms-phase-master-data.test.ts` prevents regression.
- No DB schema changes.

---

## Phase 3 — Inventory Domain Audit & Reconstruction — NEXT

**Status:** not started. Scope to be defined by the next agent after verification of Phases 1 & 2.

### Intended scope (subject to first-principles audit)

Following the same enterprise pattern used for Procurement and Warehouse:

1. **Ownership map.** Confirm Inventory owns and only owns: `stock_quants`, `stock_movements`, `stock_locations` (schema), `cost_layers`, valuation, lots/serials, reservations, `physical_counts` (adjustment authority), transfers.
2. **Canonical RPC surface.** Enumerate every write path into stock state. Every one must be `SECURITY DEFINER`, `SET search_path = public`, SoD-guarded, and row-lock the target quant/movement `FOR UPDATE`. Candidates: `post_stock_adjustment_atomic`, `post_physical_count_atomic`, `execute_stock_transfer_atomic`, `reserve_stock_atomic`, `release_reservation_atomic`, `revalue_layer_atomic`, `write_off_lot_atomic`.
3. **Governance duties.** Register `inventory.adjust.approve`, `inventory.adjust.post`, `inventory.transfer.approve`, `inventory.transfer.execute`, `inventory.revalue.post`, `inventory.count.approve` with SoD conflicts (approver ≠ poster).
4. **Cross-domain contracts.** Verify inbound event handlers exist and are idempotent for: `procurement.grn.received`, `warehouse.count.session.completed`, `manufacturing.production.completed`, `sales.shipment.picked`, `sales.return.received`. Every one lands in `business_event_outbox` consumers, never as direct writes from other apps.
5. **DB-level integrity (Batch N-equivalent).** Triggers to enforce `business_id`/`branch_id` alignment across `stock_movements` ↔ `warehouses` ↔ `stock_locations`, and to forbid negative `stock_quants` outside sanctioned reversal RPCs.
6. **UI consolidation.** Any duplicate/legacy inventory pages left over from the ADR-0079/0080 refactors get retired the same turn their replacement ships — no orphans.
7. **Architecture guardrails.** New tests forbidding: direct inserts into `stock_movements`/`stock_quants`/`cost_layers` from anywhere outside sanctioned RPCs; cross-app writers touching inventory tables directly.

### Deliverables

- ADR 0081 — Inventory domain ownership & write-path canonicalisation.
- `docs/audit/inventory-verdict.md` at close.
- Migration(s) for governance duties + integrity triggers + any missing canonical RPCs.
- Architecture tests: `src/test/architecture/inventory-write-paths.test.ts`.

---

## Instructions for the next agent

**Do not start Phase 3 by writing code.** Follow this order:

### Step 1 — Verify Phases 1 & 2 are actually production-grade

Before adding anything, prove the previous arcs meet the standards claimed in their verdicts. Failing checks = fix them in-arc before opening Phase 3.

**Procurement verification (run all):**

```sql
-- 13 canonical RPCs present, all SECURITY DEFINER, all search_path pinned
SELECT proname, prosecdef, proconfig FROM pg_proc
WHERE proname IN (
  'approve_purchase_order','receive_inbound_shipment','create_goods_receipt',
  'match_bill_atomic','match_bill_with_landed_cost','confirm_bill_atomic',
  'record_bill_payment_atomic','post_journal_entry_atomic',
  'void_journal_entry_atomic','sync_po_line_billed_quantities',
  'allocate_landed_cost_bill','post_landed_cost_bill',
  'apply_vendor_credit_note_atomic'
);
-- expect 13 rows, all prosecdef=true, all proconfig contains 'search_path=public'

-- Legacy retired
SELECT count(*) FROM pg_proc WHERE proname='apply_vendor_credit_atomic'; -- expect 0

-- Batch N triggers present
SELECT count(*) FROM pg_trigger WHERE tgname IN (
  'trg_bills_branch_business','trg_purchase_orders_branch_business',
  'trg_vendor_credit_notes_branch_business','trg_bill_payments_branch_business',
  'trg_journal_entries_branch_business','trg_bills_po_business',
  'trg_vcn_applications_business'
); -- expect 7

-- No supplier_id leaks on transactional docs (ADR-0079)
SELECT table_name FROM information_schema.columns
WHERE table_schema='public' AND column_name='supplier_id'
  AND table_name IN ('bills','purchase_orders','rfq_vendors',
                     'purchase_returns','vendor_credit_notes'); -- expect 0

-- Governance duties + SoD
SELECT count(*) FROM governance_duties WHERE duty_code LIKE 'credit.%'; -- expect 2
```

Also confirm:
- `rg -n "apply_vendor_credit_atomic" src/` returns nothing.
- `/purchases/vendors` in browser 301s to `/purchases/suppliers`.
- Supplier 360 (`/purchases/suppliers/:id`) shows Finance defaults + Custom fields panel.

**Warehouse verification:**

- `bunx vitest run src/test/architecture/wms-phase-master-data.test.ts` — green.
- `rg -n "pages/inventory/Warehouse" src/` returns nothing (only historical references in `docs/` or migrations OK).
- `/inventory-app/warehouses` and `/inventory-app/warehouses/<uuid>` in browser both redirect to `/warehouse-app/warehouses[...]` preserving the id.
- Inventory sidebar has no "Warehouses" entry; Warehouse sidebar does.
- Warehouse `CycleCounts` page and Inventory `PhysicalCountWorkspace` each render the cross-app callout linking to the other.

**Global:**

- `tsgo -p tsconfig.app.json` — clean.
- `bunx vitest run src/test/architecture` — all green.
- `supabase--linter` — no new errors introduced by the last two arcs.

If any check fails, **fix under the owning phase (1 or 2)** and re-close before opening Phase 3. Do not paper over a Phase 1/2 defect inside Phase 3.

### Step 2 — Open Phase 3 with the same discipline

1. **Discovery pass first, no code.** Read `src/apps/inventory/**`, `src/hooks/useStock*`, `src/pages/inventory/**`, every migration touching `stock_*` / `cost_layers` / `physical_counts`. Produce a written ownership map + write-path inventory as the first turn's deliverable.
2. **Draft ADR 0081** with the ownership decision before touching any migration.
3. **Batch discipline.** Split into I1 (RPC canonicalisation), I2 (governance duties + SoD), I3 (integrity triggers), I4 (event-contract verification), I5 (UI consolidation), I6 (arch guardrails), I7 (verdict + close). Each batch ships to a coherent, production-ready state — no partials, no orphans, no jumping ahead.
4. **Retire legacy in the same turn as the replacement.** Never leave a legacy RPC/route/page live past the migration that supersedes it. Update all callers + the arch-guard allow-list in the same turn.
5. **Close with a verdict doc** at `docs/audit/inventory-verdict.md` and update this file to mark Phase 3 CLOSED + Phase 4 active.

### Guardrails that apply to every future phase

- Every new `public` table needs `GRANT`s in the same migration.
- Every new RPC is `SECURITY DEFINER` + `SET search_path = public` + SoD-guarded + `FOR UPDATE` locks its aggregate.
- No client-side writes to ledger/state tables. Cross-app writes go through `business_event_outbox`.
- Party-vs-role (ADR-0079) is universal — no `<entity>_id` FKs where `contacts.id` is the correct party reference.
- Ownership boundaries enforced at the directory + arch-test level, not by convention.

Do not open Phase 4 (Sales) until Phase 3 is CLOSED with a published verdict.
