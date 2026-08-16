# Landed Cost Domain — Authoritative Project Status

Last updated: 2026-08-16. This file is the single source of truth for landed-cost
status. Supersedes every earlier landed-cost file in `.lovable/plan/`.

## Verdict on the domain

Landed Cost is a **first-class domain that consumes canonical engines**, not a page.
One voucher engine (`landed_cost_allocate_voucher`, `landed_cost_post_voucher` →
`_landed_cost_post_apply`, `landed_cost_reverse_voucher`), FX stamped server-side,
valuation through `inventory_apply_cost_revaluation`, accounting through
`post_journal_entry_atomic`, accounts through `resolve_posting_account`, governance
through the approval registry, events through `_emit_landed_cost_outbox`.

## Phase status

| Phase | Scope | State |
| --- | --- | --- |
| A | Full lifecycle executed against live data (allocate → post → reverse) | ✅ done & verified |
| B1 | Receipt reversal / goods-receipt cancellation guard | ✅ done & verified |
| B2 | Supplier credit note / freight-bill reversal after capitalisation | ✅ done & verified |
| B3 | Transfer / scrap between receipt and posting (lineage + reversal split) | ✅ done & verified |
| B4 | Cross-branch / cross-warehouse voucher scope | ✅ verified, no code change needed |
| B5 | Concurrent post / re-post (row locking, idempotency) | ✅ verified, no code change needed |
| C | Retire the parallel `landed_cost_selftest*` verification path | ✅ done & verified |
| D | Weight / volume allocation bases | ✅ supported — earlier "blocked" claim was WRONG |
| E | Operator comprehension pass on the workspace (server-side aggregate) | ✅ done & verified |
| F | **Weight / volume basis end-to-end execution against seeded data** | 🔴 **ACTIVE — start here** |
| G | Authenticated browser verification of the landed-cost workspace | ⏸ blocked in this environment |

### What is fully implemented and verified

- **A.** Voucher `LCV-2026-00001` driven end to end: allocation exact to the minor
  unit, 348 : 152 on-hand/consumed split (capitalised 51.50 / expensed 22.50),
  balanced journal, outbox event, reversal by compensating entry. Two defects found
  and fixed in the process: AVCO was not moved by revaluation (now
  `inventory_sync_avco_from_layers` + `trg_inventory_revaluation_avco_sync`,
  registered in `inventory_valuation_writers`), and landed-cost events were
  dead-lettering as `unknown_event_type` (topics now registered). Evidence:
  `docs/audit/2026-08-16-landed-cost-lifecycle-execution.md`.
- **B1.** `landed_cost_assert_receipt_unencumbered` refuses receipt reversal while a
  posted voucher references it.
- **B2.** `landed_cost_bill_encumbrance` authority refuses supplier credit notes
  against a capitalised bill, naming the voucher and amount; enforced on draft and
  on post by a trigger on `vendor_credit_notes`; `resolve_reversal_intent` annotated
  to recommend reversing landed cost first. Internal assertion is `service_role`
  only. Evidence: `docs/audit/2026-08-16-landed-cost-bill-encumbrance.md`.
- **B3.** Transfer lineage capture plus the warehouse-correct reversal split.
  Evidence: `docs/audit/2026-08-16-landed-cost-transfer-lineage.md`,
  `docs/audit/2026-08-16-landed-cost-reversal-split.md`.
- **B4/B5.** All mutating functions take `FOR UPDATE`; posting is idempotent by
  `(source_type, source_id)`; reversal iterates per cost layer and a layer belongs to
  one warehouse, so the unwind is warehouse-correct by construction.
- **C.** `landed_cost_selftest` / `landed_cost_selftest_run` dropped along with their
  writer-registry exemptions; `check_valuation_writer_coverage()` returns 0 issues,
  `check_inventory_valuation_drift()` returns 0 rows.
- **D.** `product_physical_attributes` (net/tare/derived gross weight, volume, L/W/H,
  each with its own UoM, keyed by `(product_id, packaging_id)`) is the canonical
  model; `resolve_product_measure` normalises and fails closed;
  `landed_cost_allocate_voucher` already allocates by `weight` and `volume`;
  `ProductForm` captures the attributes and `InventorySettings` can make them
  mandatory. The refusal seen in testing was **data absence (0 rows)**, not a
  modelling gap.
- **E.** `landed_cost_workspace_summary(business_id)` — one set-based aggregate,
  `STABLE`, invoker rights so RLS scopes it. `LandedCostListPage` renders it; the
  client-side `landedCostKpis` reducer was deleted and an architecture guard now
  rejects client-side landed-cost totals.

### Ratchets in place

`supabase/tests/landed_cost_{hardening,currency_fx,basis_immutability,receipt_reversal_guard,bill_encumbrance,transfer_lineage,reversal_split,workspace_and_selftest}_test.sql`
and `product_measure_landed_cost_basis_test.sql`, plus `landed-cost.test.ts`,
`landed-cost-currency.test.ts`, `stock-event-fabric-and-landed-cost.test.ts`.

## Phase F — ACTIVE: prove weight / volume allocation end to end

Phase D proved the capability exists by introspection. It has never been *exercised*,
because no product in this database carries physical attributes. Close that.

1. **Seed data — explicitly allowed.** Populate `product_physical_attributes` for the
   products on a real goods receipt (base unit and at least one packaging level, with
   proper UoM ids), through the canonical path (the product form / the same RPC the
   form uses) — never by hand-writing derived columns such as `gross_weight`, which
   the integrity trigger derives.
2. Create a voucher with a **weight**-basis component and a second with a
   **volume**-basis component over that receipt. Allocate, and verify:
   - the basis sum equals the sum of `resolve_product_measure` per line at the
     packaging level actually received (gross preferred, net fallback);
   - allocation total equals the charge total to the last minor unit and is
     deterministic on re-run;
   - a mixed-packaging receipt allocates by the received pack level, not the base
     unit;
   - a line whose product has **no** measure still refuses, naming that product.
3. Post and reverse one of them; confirm the same invariants Phase A established:
   AVCO moved by exactly the capitalised amount, consumed portion in COGS, journal
   balanced with `source_type = 'landed_cost_voucher'`, one outbox event, zero
   valuation drift before and after, reversal by compensating entry.
4. Confirm the operator-facing refusal message and the basis picker hints match what
   the engine actually requires.
5. Record the run in `docs/audit/2026-08-16-landed-cost-weight-volume-execution.md`
   and add a SQL probe asserting the weight/volume allocation invariants.

Any discrepancy found here is fixed in the **canonical engine** (measure resolution,
valuation, accounting) — never with a landed-cost-local workaround.

## Phase G — after F

Authenticated end-to-end browser verification of the workspace. Currently
unavailable: external, unmanaged Supabase, so the preview redirects to sign-in and no
session can be minted in this environment. Do not simulate it; verify public routes
and record the limitation.

## Instructions for the next agent

1. **Verify before you continue. Dig, do not assume.** Everything above was verified
   against the live database and the running code, but re-prove the pieces you are
   about to build on: query `pg_proc` for overload counts and ACLs, read the live
   function bodies, read the frontend files, run the probes. Two claims in this
   domain's history were confidently wrong (Phase D "blocked", AVCO "in sync") — both
   from reading a plausible-looking subset instead of the whole model. If you cannot
   show the evidence, write "unverified", do not write a verdict.
2. **Never accept a "blocked" label without reproducing the blockage yourself**, and
   distinguish *data absence* from a *capability gap*. Read the failing function's
   body and the actual rows before concluding anything is missing.
3. **You may seed data for testing.** Seeding physical attributes, receipts, vouchers
   and charge components in a scratch business is expected and encouraged — via
   canonical RPCs and normal writes, never by minting privileged fixtures, never by
   bypassing a trigger or a single-writer registry, and never by dropping a guard to
   make a test pass.
4. **Resume at Phase F step 1.** Do not re-audit A–E and do not wander into POS,
   sales or product waves — those have their own status files.
5. Bring F to a coherent, production-ready state (execution + audit doc + probe)
   before touching G.
6. Checks after each unit: `npm run typecheck:landed-costs`, the three landed-cost
   architecture test files, and the `supabase/tests/landed_cost_*` probes. Update this
   file's phase table with each verdict before moving on.
