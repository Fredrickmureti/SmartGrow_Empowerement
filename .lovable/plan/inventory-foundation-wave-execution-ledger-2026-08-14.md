# Inventory Foundation Wave — execution ledger

**Reference architecture:** ADR 0142 (single balance / availability / reservation),
ADR 0078 (AVCO canonical), ADR 0064 (locations & quants), ADR 0025 (lot quants & FEFO),
ADR 0079 (Inventory vs Warehouse).
**Domain map:** `docs/audit/inventory-domain-map.md`
**Last updated:** 2026-08-14 (handoff verification session)

---

## Part 1 — Status ledger

| Phase | Scope | State |
|---|---|---|
| 1 | Single balance store + single availability engine | VERIFIED |
| 1b | `get_available_pos_stock_for_register` repointed onto the engine | VERIFIED |
| 2 | Single reservation engine + lifecycle | VERIFIED |
| 3 | Movement ledger completeness | VERIFIED (re-verified this session) |
| 4 | Costing & valuation guard (AVCO canonical, ADR 0078) | VERIFIED (re-verified this session) |
| 5 | Lots / serials / expiry traceability closure | IN PROGRESS — partial foundation exists, gaps below |
| 6 | Business events: one emitter, complete topics | NOT STARTED |
| 7 | UI repoint — clear the allowlisted files | NOT STARTED |
| 8 | Documentation + operator guide refresh | NOT STARTED |

---

## Part 2 — Verification verdict on the previous agent's claims

Checked directly against the live database, not the ledger text.

| Claim | Verdict | Evidence |
|---|---|---|
| Reversal parity registry + coverage check | Confirmed | `stock_movement_writers` = 25 rows; `check_movement_reversal_coverage()` returns 0 rows |
| Provenance registry | Confirmed | `stock_movement_source_types` = 27 rows |
| Integrity trigger with five error codes | Confirmed | `trg_enforce_stock_movement_integrity` present on `stock_movements` |
| Four-way drift check | Confirmed | `check_stock_quant_drift(NULL)` returns 0 rows |
| Valuation writer registry + coverage | Confirmed | `inventory_valuation_writers` = 5 rows; `check_valuation_writer_coverage()` returns 0 rows |
| Valuation authority triggers | Confirmed, names differ from ledger | actual: `trg_enforce_valuation_authority_ws` (warehouse_stock), `trg_enforce_valuation_authority_cl` (cost_layers) |
| Valuation drift check | Confirmed | `check_inventory_valuation_drift(NULL, 0.01)` returns 0 rows |
| Ratchets present | Confirmed | `supabase/tests/inventory_movement_ledger_test.sql`, `inventory_valuation_guard_test.sql` |

Caveat recorded for the next agent: the tenant database currently holds **zero
`stock_movements`, zero `stock_lots`, zero `stock_serials` and zero
lot/serial-tracked products**. Every "returns 0 rows" result above is therefore a
*structural* pass, not a behavioural one. Phases 1–4 are verified as
architecture; they are not yet proven against live volume. Phase 5 adds the
first behavioural ratchet that does not depend on tenant data.

Phase 4 is marked VERIFIED and the ledger is now correct — the only outstanding
item the previous agent named (updating this file) is done.

---

## Part 3 — Phase 5 scope: lots, serials, expiry, traceability

Reconnaissance found a real foundation already in place, so Phase 5 is closure,
not construction. Do not rebuild any of these:

Present and correct: `stock_lots` / `stock_serials` masters, per-lot balances via
`_maintain_warehouse_stock_lots`, `resolve_fefo_lots` + `consume_lots_atomic`,
`enforce_serial_on_movement`, `enforce_downstream_lot_stamping` (invoices, credit
notes, sales returns), `recall_lot`, `rebuild_warehouse_stock_lots`, the
`LotPickerPopover` / `SerialPickerPopover` / `OutboundLineTracking` UI seam, and
architecture tests `recall-rpc`, `serial-tracking`, `outbound-lot-serial-ui`.

Confirmed gaps to close in Phase 5:

1. **No expiry policy at the movement boundary.** No routine in the database
   references `stock_lots.expiry_date` for outbound blocking. An expired lot can
   be sold, transferred or picked with no server-side objection; `expiry_alert_days`
   is a UI-only notion today. Add a policy-driven guard (business configuration,
   not hardcoded): block / warn / allow outbound consumption of expired lots,
   resolved server-side, with the decision stamped on the movement.
2. **Genealogy is assembled in the browser.** `src/pages/inventory/LotDetail.tsx`
   builds the lot lifecycle chain from raw table reads in the page. Move it to a
   canonical server-side projection (`trace_lot_genealogy`) returning the
   supplier → receipt → lot → warehouse → transfer → sale → customer chain, and
   repoint `LotDetail` and `recall_lot` onto the same function so recall analysis
   and the operator screen cannot disagree.
3. **No lot/serial integrity ratchet.** Phases 3 and 4 each ship a
   `supabase/tests/*.sql` ratchet; lots and serials have none. Add
   `inventory_lot_serial_traceability_test.sql` asserting: the lot-tracked
   outbound requirement is enforced, serial enforcement trigger is installed,
   the expiry guard raises its documented error codes, `warehouse_stock_lots`
   remains a derived projection, and the genealogy function exists.
4. **Serial lifecycle has no drift check.** `stock_serials.status` /
   `current_warehouse_id` are maintained by trigger, but nothing detects a serial
   whose status disagrees with its last movement. Extend the existing integrity
   surface (`check_stock_quant_drift` family) with a serial-position check rather
   than adding a new page.
5. **Traceability surfacing.** Add the two new checks as cards on the existing
   `/inventory-app/reports/integrity` page. No new route.

Explicitly out of scope for Phase 5: recall workflow UI, FEFO changes for
non-expiry-tracked products, Warehouse-owned pick execution, and any change to
Purchasing or Sales.

---

## Part 4 — Phases 6–8 (unchanged, dependency-ordered)

- **Phase 6 — Events.** One emitter. Audit `trg_stock_movement_emit_event`
  against `business_event_outbox` topic coverage; every lot/serial/valuation
  state transition from Phases 3–5 must emit with an idempotency key of the
  documented `stock.<entity>:<id>` shape. No new event infrastructure.
- **Phase 7 — UI repoint.** Blocked until Phases 5–6 are ratcheted. Clear the
  allowlisted files that still compute inventory truth in the browser.
- **Phase 8 — Docs.** ADR addendum for the expiry policy and genealogy
  projection; refresh the operator guide.

---

## Part 5 — Technical notes for the implementing agent

- Expiry policy belongs in the existing business-configuration mechanism
  (`default_account_settings`-style pattern or the branch-overridable settings
  table), never as a literal in the movement trigger.
- The expiry guard must run inside the same transaction as the movement insert,
  as a `BEFORE INSERT` addition to the existing integrity trigger chain — do not
  add a competing trigger that duplicates `enforce_stock_movement_integrity`.
- `trace_lot_genealogy(business_id, product_id, lot_number)` returns a single
  `jsonb` document. `recall_lot` calls it instead of re-querying.
- Register any new routine that writes `stock_movements` in
  `stock_movement_writers`, or the Phase 3 ratchet will fail — that is intended.
- Re-run all four checks before resuming:
  `check_movement_reversal_coverage()`, `check_stock_quant_drift(NULL)`,
  `check_valuation_writer_coverage()`, `check_inventory_valuation_drift(NULL, 0.01)`.
