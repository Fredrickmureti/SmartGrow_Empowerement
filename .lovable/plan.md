# Landed Cost Domain — Authoritative Project Status & Execution Plan

Last updated: 2026-08-16 (21:10 EAT). **This file is the single authoritative source of
project status.** It supersedes every earlier landed-cost file in `.lovable/plan/`
(those remain readable as history only).

Active phase: **F2 — real transfer → post → reverse proof across two warehouses.**
Next task after F2: **H — document numbering completion (WMS writers).**

---

## 1. Architectural contract (do not violate)

- Landed Cost is a **consumer**, never an authority. Canonical engines own the truth:
  FX (server-stamped), UoM (`convert_uom`), valuation (`inventory_apply_cost_revaluation`,
  `inventory_reverse_cost_revaluation`, `inventory_sync_avco_from_layers`),
  accounting (`post_journal_entry_atomic`), governance (approval registry),
  documents (numbering engine), events (outbox), audit.
- **One writer per operation.** No parallel/self-test/shadow paths.
- Any discrepancy is fixed **at the canonical engine**, never with a landed-cost-local
  workaround, fallback, or relaxed guard.
- **Refuse rather than fabricate.** Missing physical measures ⇒ allocation is refused
  by product name; no estimated weights, no silent value-basis fallback.
- Seeding test data is allowed, but **only through canonical RPCs and normal writes**.
- No document number may be derived from a UUID fragment.

---

## 2. Fully implemented and verified

| Phase | Scope | Evidence |
| --- | --- | --- |
| A | Voucher → component → allocation → post → reverse lifecycle on real data | LCV-2026-00001 `reversed`; LCV-2026-00002/00003 `posted` |
| B1 | Basis immutability after allocation | `supabase/tests/landed_cost_basis_immutability_test.sql` |
| B2 | Bill / vendor-credit-note encumbrance guard | `landed_cost_assert_bill_unencumbered`, `_landed_cost_guard_vendor_credit_note`; `landed_cost_bill_encumbrance_test.sql` |
| C | Parallel self-test path retired | no `landed_cost_selftest*` in `public` |
| D | Weight/volume capability (`resolve_product_measure`, packaging-level resolution) | resolves at exact packaging level, falls back base × pack size, normalises via UoM engine, returns NULL when the fact is absent |
| E | Server-side workspace KPIs | `landed_cost_workspace_summary` is the only KPI source in `landedCostRpcs.ts`; architecture guard in `src/test/architecture/landed-cost.test.ts` |
| **F** | **Weight & volume allocation proven end to end, then posted** | see below |
| G(part) | Professional document numbering for GRN + FX revaluation | `get_next_grn_number`; `document_numbering_no_uuid_test.sql` |

### Phase F detail (complete)

- Physical attributes captured for Sugar (1 kg base, 50 kg bag) and Cooking Oil
  (0.92 kg/L base, 20 L drum) at **packaging level**; gross weight derived by the
  integrity trigger. Chair and Cable deliberately left blank. `product_physical_attributes` = 4 rows.
- Real mixed-packaging GRN through `create_goods_receipt` (4 bags Sugar, 3 drums Oil).
- Weight basis, freight 8,000: Sugar 201 kg → 6,189.38, Oil 58.8 kg → 1,810.62.
- Volume basis, insurance 3,000: Sugar 224 L → 2,341.46, Oil 63 L → 658.54.
  Both sum exactly to the component and both differ from a value split.
- **Refusal proven**: weight allocation over Chairs raised
  “no weight recorded for Chair — capture the product physical attributes first”,
  zero allocation rows written (LCV-2026-00004 remains `draft` on purpose — it is the
  living refusal fixture; **do not allocate or delete it**).
- Both vouchers **posted**: balanced Dr 1200 Inventory / Cr 2099 Landed Cost Clearing,
  one `procurement.landed_cost.posted` outbox event each, layer unit costs raised by
  exactly the allocated amounts (Sugar 2.40 → 45.05, Oil 12.50 → 53.65).
  Governance was not bypassed: org is in `solo` mode, actor is the owner,
  `governance_assert_not_self` auto-allowed and wrote an SoD audit row.

### Canonical defects found and fixed during F

1. `convert_uom` raised on a NULL quantity, making it impossible to record a net
   weight without a tare weight → now returns NULL for an absent quantity.
2. `update_weighted_avg_cost_on_receipt` was a **second costing authority** and read
   `products.stock_quantity` *before* the stock trigger applied the receipt, so every
   receipt into existing stock overwrote AVCO with the last purchase price
   (Chair: 2,000 instead of 2,428.57 — 7,500 of value drift). It now delegates to
   `inventory_sync_avco_from_layers`; cost layers are the sole source of truth; all
   AVCO re-derived. `check_inventory_valuation_drift()` returns **0 rows** today.
3. Goods receipts minted `GRN-YYYYMMDD-<uuid8>` instead of using the numbering
   engine. `get_next_grn_number(org, business, branch)` (advisory-locked, honours the
   company/branch prefix setting) is now used by `create_goods_receipt` and
   `receive_inbound_shipment`; FX runs use `FXREV-`/`FXREVR-`; the three existing
   receipts were renumbered chronologically (`GRN-20260816-bec22190` → `GRN-2026-00002`).

### Ratchet tests in place

`landed_cost_basis_immutability_test.sql`, `landed_cost_bill_encumbrance_test.sql`,
`landed_cost_currency_fx_test.sql`, `landed_cost_hardening_test.sql`,
`landed_cost_weight_volume_test.sql`, `inventory_avco_single_writer_test.sql`,
`document_numbering_no_uuid_test.sql`, `src/test/architecture/landed-cost.test.ts`.

Write-ups: `docs/audit/2026-08-16-landed-cost-physical-basis.md`,
`docs/audit/2026-08-16-landed-cost-posting-and-avco-writer.md`.

---

## 3. Pending work (in execution order)

### F2 — ACTIVE — transfer / reversal proof on real data

`stock_transfers` is **empty**; the warehouse-split reversal has only ever been proven
inside a rolled-back rehearsal. This is the one remaining claim weaker than its billing.

Do, for real, through canonical RPCs only:

1. Receive a fresh lot into warehouse A (canonical `create_goods_receipt`).
2. Transfer **part** of it to warehouse B through the canonical transfer RPC
   (find the single writer first; do not write `stock_transfers` directly).
3. Consume a small quantity at B (sale or issue) so the reversal must split between
   on-hand value and already-consumed value (COGS) — this is the whole point of the case.
4. Create + allocate + post a landed-cost voucher against the receipt.
5. Reverse the voucher.

Assert after reversal:
- origin **and** destination layers return to their pre-landed-cost unit cost;
- the consumed portion is corrected through COGS, not silently absorbed;
- AVCO is re-derived per warehouse from layers (no writer other than
  `inventory_sync_avco_from_layers` touched it);
- `check_inventory_valuation_drift()` = 0 rows in both warehouse scopes;
- the reversing journal is balanced and mirrors the original, and a reversal outbox
  event exists.

Any defect belongs to `inventory_reverse_cost_revaluation` (or the transfer engine) —
fix it there. Land a ratchet `supabase/tests/landed_cost_transfer_reversal_test.sql`
and an audit note under `docs/audit/`.

### H — NEXT — finish document numbering (WMS writers)

Six live functions still mint prefixed identifiers from UUID fragments:
`create_pick_wave`, `open_pack_carton`, `receive_goods_to_wms`,
`wms_enqueue_order_for_wave`, `wms_plan_waves`, `wms_split_putaway_task`.
Route each through the canonical numbering engine (advisory-locked, per org/branch/year),
renumber existing rows chronologically, and extend
`document_numbering_no_uuid_test.sql` to cover the WMS prefixes so it fails if any of
them regresses. Purely internal, non-user-facing keys may stay UUID-based **only** if
they never appear in a document, screen, or report — state which, and prove it.

### I — authenticated browser verification of the landed-cost UI

Currently blocked: external/unmanaged Supabase, no session can be minted in the
sandbox. Verify public routes only, record the limitation, and **do not simulate a
session**. If the project is later moved to managed Supabase, run:
workspace KPIs match `landed_cost_workspace_summary`, allocate/post/reverse from the
UI, refusal message surfaces verbatim to the user, and posted vouchers are read-only.

---

## 4. Instructions for the next agent

1. **Verify before you build.** Do not trust this file. Re-check against the live
   database and the working tree, at minimum:
   - one overload each for `landed_cost_allocate_voucher`, `landed_cost_post_voucher`,
     `_landed_cost_post_apply`, `landed_cost_reverse_voucher`,
     `inventory_apply_cost_revaluation`, `inventory_reverse_cost_revaluation`,
     `inventory_sync_avco_from_layers`, `resolve_product_measure`;
   - `update_weighted_avg_cost_on_receipt` still only delegates to
     `inventory_sync_avco_from_layers`;
   - `check_inventory_valuation_drift()` returns 0 rows;
   - LCV-2026-00002/00003 `posted` with balanced journals and one event each;
     LCV-2026-00004 still `draft` with zero allocations;
   - no live function builds a document number from a UUID fragment except the six
     WMS functions named in Phase H;
   - the ratchet tests in §2 all pass.
   Record the verdict as a short table at the top of §2 before writing any new code.
2. **Then resume at Phase F2** — not somewhere else. Finish F2 completely (execution,
   assertions, defect fixes at the canonical engine, ratchet test, audit note, this
   file updated) before opening Phase H.
3. **Simulate real events; never assume.** Exercise the actual RPCs on seeded but real
   data. No rolled-back rehearsals as final proof, no bypassing governance except the
   documented owner-JWT migration pattern (and say so when used), no half-done
   workflows, no orphaned functions, no relaxed guards to make a test pass.
4. **Keep this file current.** After each unit of work: run
   `npm run typecheck:landed-costs`, the landed-cost architecture tests and the
   `supabase/tests/landed_cost_*` probes, then move the item from §3 to §2 with its
   evidence and update the “Active phase” line at the top.
