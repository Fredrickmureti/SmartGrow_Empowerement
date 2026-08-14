# Inventory Foundation Wave — verification verdict + Phase 3 execution

**Reference architecture:** ADR 0142 (single balance / availability / reservation),
ADR 0078 (AVCO canonical), ADR 0064 (locations & quants), ADR 0079 (Inventory vs Warehouse).
**Domain map:** `docs/audit/inventory-domain-map.md`
**Last updated:** 2026-08-14 (handover verification session)

---

## Part 1 — Verification of the previous engineer's claims

Every claim below was re-checked directly against the live database this
session (function bodies, triggers, constraints, columns) and against the
codebase. Nothing was accepted on the strength of the ledger.

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 2: `reserve_stock_atomic` is the only writer of reservation rows | **HOLDS** | No other function in `public` contains an insert into `stock_reservations` |
| Phase 2: duplicate engines removed | **HOLDS** | `reserve_stock`, `create_stock_reservation`, `release_stock`, `release_reserved_stock` all absent |
| Phase 2: lifecycle columns + 3 triggers | **HOLDS** | `trg_stock_reservations_sync_state`, `trg_project_warehouse_stock_reservations`, `trg_guard_quant_reserved` all present |
| Phase 1: quants are the maintained balance, `warehouse_stock` a projection | **HOLDS** | `trg_maintain_stock_quants` + `trg_project_warehouse_stock` present |
| Phase 1: `get_available_stock` / `get_available_pos_stock` are thin wrappers | **HOLDS** | Both bodies delegate to `resolve_stock_availability` |
| **Phase 1: `get_available_pos_stock_for_register` is a thin wrapper** | **FALSE** | It still reads `warehouse_stock.quantity` directly, subtracts its own reserved sum, and filters reservations on the legacy `released_at IS NULL` instead of the `status` lifecycle. It is a live fourth availability formula, blind to blocked / quarantine / transit state, and it will misread any reservation closed via `status` without stamping `released_at`. |

Phase 1 is therefore **not** complete as marked. It is re-opened as Phase 1b
below and must be closed before Phase 3 work is trusted, because POS sells
against this function.

### Additional findings that change the Phase 3 definition of done

- **Provenance (Phase 3 item 3) is effectively not started.** The trigger named
  `enforce_stock_movement_provenance` only checks that `source_packaging_id`
  belongs to the movement's product. `reference_type` and `reference_id` are
  both nullable and unvalidated, so a movement can exist with no source
  document at all.
- **Drift detection (Phase 3 item 4) is partial.** `check_stock_quant_drift`
  exists but compares only `warehouse_stock` vs `stock_quants`. It ignores
  `products.stock_quantity` and `warehouse_stock_lots`, and there is no SQL
  ratchet in `supabase/tests/` protecting it.
- **Reversal (Phase 3 item 1) has a good primitive, unproven coverage.**
  `reverse_stock_movement` is correctly built (blocks reversing a reversal,
  blocks double reversal, authorizes the actor, writes a compensating row).
  What is unproven is parity: roughly 22 functions insert into
  `stock_movements` and no test asserts each has a reversal path.
- **Revaluation (Phase 3 item 2) has no guard.** `inventory_apply_cost_revaluation`
  is value-only today, but nothing rejects a `landed_cost` movement that
  carries a non-zero quantity.

---

## Part 2 — Status ledger

| Phase | Scope | State |
|---|---|---|
| 1 | Single balance store + single availability engine | ⚠ REOPENED — see 1b |
| 1b | Repoint `get_available_pos_stock_for_register` onto the engine | ▶ ACTIVE |
| 2 | Single reservation engine + lifecycle | ✅ VERIFIED |
| 3 | Movement ledger completeness | IN PROGRESS (1 of 4 items partly built) |
| 4 | Costing & valuation guard (AVCO canonical) | NOT STARTED |
| 5 | Lots / serials / expiry traceability closure | NOT STARTED |
| 6 | Business events: one emitter, complete topics | NOT STARTED |
| 7 | UI repoint — clear the 8 allowlisted files | NOT STARTED |
| 8 | Documentation + operator guide refresh | NOT STARTED |

---

## Part 3 — Work to execute, in dependency order

### Phase 1b — close the fourth availability formula (do first)

Rewrite `get_available_pos_stock_for_register` so the only logic it owns is
resolving the register's warehouse; the number itself comes from
`resolve_stock_availability`. The `p_exclude_self` behaviour (a register
ignoring its own hold) is a real POS requirement and must be preserved — it
becomes an explicit "exclude these reservation sources" argument on the
canonical resolver rather than a second formula. Add the function to the
reservation/availability SQL ratchet so a fourth formula cannot reappear.

Done when: the function body contains no arithmetic over `warehouse_stock`, no
reference to `released_at`, and POS availability equals
`resolve_stock_availability` for the same product/warehouse.

### Phase 3 — movement ledger completeness

1. **Reversal parity.** Enumerate every function that inserts into
   `stock_movements`, and for each record either its reversal path or that it
   is itself a reversal. Close the gaps by routing them through
   `reverse_stock_movement` rather than writing bespoke compensating logic.
   Ratchet: a SQL test that fails when a new movement writer appears without a
   registered reversal.
2. **Value-only revaluation guard.** A trigger that rejects any `landed_cost`
   (or other value-only) movement carrying non-zero quantity, and rejects any
   quantity-bearing movement type carrying only value.
3. **Provenance.** Make `reference_type` / `reference_id` mandatory on every
   movement type except explicitly listed value-only and migration types, and
   validate that the referenced document exists in the table the
   `reference_type` names. Backfill is a non-issue: the movement ledger is
   empty.
4. **Drift detection.** Extend the drift RPC to cover all four stores
   (`stock_quants`, `warehouse_stock`, `warehouse_stock_lots`,
   `products.stock_quantity`), surface it as an Inventory integrity report, and
   ratchet it.

### Phases 4–8

Unchanged in intent from the previous ledger; they stay blocked behind Phase 3.
Phase 4 adds the guard enforcing ADR 0078 (AVCO canonical, `cost_layers` = lot
detail only) rather than any new valuation engine. Phase 7 clears the eight
files on the `PENDING_MIGRATION` allowlist in
`src/test/architecture/availability-is-server-owned.test.ts`.

---

## Technical notes

- No new engines are introduced anywhere in this plan. Every item either
  repoints a caller onto an existing canonical function or adds a guard/test
  around one.
- All changes are database migrations plus SQL ratchets under
  `supabase/tests/`; the only frontend work in this wave is Phase 7.
- The movement ledger and quant tables are empty, so consolidation is safe and
  no compatibility shim is warranted.
- Verification evidence for each completed item is recorded in Part 1 of this
  file; the next agent should extend that table rather than restarting
  reconnaissance.
