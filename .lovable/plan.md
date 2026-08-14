# Inventory Foundation Wave — Phase 8 closure plan

**Goal:** finish Phase 8 (documentation + behavioural sweep), retire the last
Phase 7 follow-up, and archive this plan so the next wave starts clean.

Phases 1–7 were independently re-verified against the live database on 2026-08-14
(evidence retained in the execution ledger under `.lovable/plan/`). They are not
re-opened here.

---

## 8a. Behavioural proof (the wave's only real gap)

Everything to date is *structurally* proven — the tenant database holds 0
`stock_movements` and 0 `stock_quants`, so no end-to-end path has ever executed.

Approach: drive one real receipt through the running app in the browser
(Playwright against the dev server, signed in with a sandbox session), not via
raw SQL inserts — inserting rows directly would bypass exactly the writers and
triggers being proven.

Assertions after that single receipt:

```text
1 stock_movement  →  1 stock_quant row at the receiving location
                  →  1 warehouse_stock row in sync
                  →  1 cost_layer with the expected AVCO unit cost
                  →  1 business_event_outbox row, inventory.movement.recorded,
                     handler_scope = 'server', drained by outbox-dispatcher
```

Then a second movement (issue/sale of part of the receipt) to prove reservation
release, quant decrement and COGS layer consumption at the same AVCO.

If the sandbox cannot mint an authenticated session, the fallback is to call the
same server RPCs the UI calls (not table inserts) with a seeded fixture tagged
`is_sample_data = true`, and to record in the ledger that the UI leg is unproven.
All fixture rows are removed at the end of the run either way.

## 8b. Guard sweep — run and read in full

`inventory_movement_ledger_test.sql`, `inventory_valuation_guard_test.sql`,
`inventory_lot_serial_traceability_test.sql`, `inventory_event_fabric_test.sql`,
`inventory_reservation_engine_test.sql`,
`inventory_availability_single_formula_test.sql`, plus
`check_movement_reversal_coverage()`, `check_stock_quant_drift(NULL)`,
`check_valuation_writer_coverage()`, `check_inventory_valuation_drift(NULL, 0.01)`,
`check_serial_position_drift(NULL)`.

Run them **after** 8a so the drift checks have real rows to inspect — today they
pass vacuously. Any failure is fixed inside this phase, not deferred.

## 8c. Retire the last Phase 7 exemption

Add a location grain to `resolve_stock_availability_batch` (optional
`p_location_ids uuid[]`, same six output columns, same single formula), repoint
`_wms_maybe_enqueue_replen` onto it, and delete its allowlist entry from
`inventory_availability_single_formula_test.sql` so the ratchet has an empty
allowlist. Migration tool only; `authenticated` + `service_role`, `anon` revoked.

## 8d. Documentation

- ADR addendum: Phase 5 expiry / quarantine policy (extends ADR 0025 / 0064).
- ADR addendum: Phase 6 event fabric — the single emitter, the 15 movement event
  classes, the 8 server-scoped `inventory.*` topics (extends ADR 0076).
- ADR 0142 addendum: the location grain from 8c.
- Refresh the inventory operator guide with the receive → quant → cost layer →
  event path proven in 8a.

## 8e. Close the wave

- Archive the ledgers and this plan to `.lovable/plan/inventory-foundation-wave-
  closed-<date>.md` with the final status table (every phase VERIFIED, and
  explicitly *behaviourally* verified where 8a covered it).
- Reset `.lovable/plan.md` to a short closing record pointing at the archive, so
  the next wave starts from an empty plan.
- Anything discovered in 8a/8b that is out of scope for the inventory foundation
  is written up as a named follow-up in the archive rather than silently carried.

---

## Technical notes

- No schema changes outside 8c, and that one goes through the migration tool.
- Behavioural proof runs against the dev server on `localhost:8080`; no
  credentials are hardcoded, the sandbox Supabase session is restored instead.
- Fixture data is tagged `is_sample_data = true` so the outbox and security scans
  skip it, and is deleted at the end of the run.
- Rules of engagement unchanged: one canonical engine per concept, no business
  logic in the browser, no phase marked VERIFIED on the strength of code existing.
