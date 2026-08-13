# Landed Cost Domain — Live Status Plan

Authoritative status for the landed cost reconstruction. Update after every
completed unit of work.

## Currently active phase

Phase 6.1 — **Finance & Inventory reporting surfaces** (next to build).
Phases 1–5C are verified complete (evidence below).

---

## Phase 1 — Independent verification of prior work (done this session)

Checked against the working tree and the live database, not the previous
notes.

| Prior claim | Verdict | Evidence |
| --- | --- | --- |
| Governance gate registered | Confirmed | `governance_action_registry` holds `landed_cost.post` and `landed_cost.reverse` |
| Posting split into gated wrapper + private applier | Confirmed | `landed_cost_post_voucher`, `_landed_cost_post_apply` both exist |
| Approval mirror + self-approval guard | Confirmed | `trg_mirror_approval_to_landed_cost` on `approval_requests`; `trg_landed_cost_self_approval` on `landed_cost_vouchers` |
| FX stamped server-side | Confirmed | `trg_lc_vouchers_fx_stamp` → `_landed_cost_voucher_fx_stamp` |
| Document kind registered | Confirmed | `document_kinds` row `purchases.landed_cost_voucher` |
| Charge-type catalog screen + routes | Confirmed | `LandedCostComponentTypesPage.tsx`; routes for list, `/new`, `/:id`, `/component-types` |
| Snapshot + dedicated PDF layout | Confirmed | `snapshots/purchasesLandedCostVoucher.ts`, ledger layout registered |
| Architecture guards | Confirmed | `src/test/architecture/landed-cost.test.ts` |
| pgTAP coverage | **Partial** | Only `supabase/tests/landed_cost_currency_fx_test.sql` exists; allocation, governance, period-lock, reversal untested |
| Reporting integration | **Absent** | No landed-cost path in `InventoryValuationReport`, `InventoryGLReconciliation`, journal-entry drill-through, or the GRN/PO records |
| `landed_cost_selftest` retired | **Not done** | `landed_cost_selftest` / `landed_cost_selftest_run` still exist in the database |

No regressions or duplicate engines found: allocation, posting, FX and
approvals all route through the canonical server engines.

---

## Phase 6.1 — Reporting surfaces (NEXT)

All three read canonical data only; no landed-cost totals tables.

1. **Finance drill-through.** The posted journal entry currently shows a
   generic "Source" label. Resolve `source_type = 'landed_cost_voucher'` to
   the voucher number with a link to the record page, and show the
   capitalised vs expensed split on the entry view.
2. **Inventory valuation attribution.** In `InventoryValuationReport` and
   `InventoryGLReconciliation`, expose the landed-cost uplift component of
   unit cost, sourced from the revaluation rows the posting engine already
   writes, with drill-through to the originating voucher.
3. **Per-shipment summary on procurement records.** A read-only section on
   the goods receipt and purchase order records: charges attached, allocated
   amount, capitalised vs expensed, voucher status. Server-side aggregate
   (a view or RPC), not a browser loop over receipt lines.
4. **Clearing-account exposure.** Surface the landed-cost clearing account
   balance and unposted-voucher exposure through the existing finance
   account-balance path so period close can see it.

## Phase 6.2 — pgTAP coverage (remainder)

New files under `supabase/tests/landed_cost_*`:
- allocation determinism and rounding-drift absorption (sum of allocations
  equals total charge to the last minor unit);
- capitalised vs expensed split when part of the receipt is already sold;
- balanced journal (debits = credits) and correct account roles;
- period-lock refusal on post;
- governance: gated post parks in `pending_approval`; approval mirror
  applies the posting; rejection reverts to `allocated`; self-approval
  blocked;
- reversal symmetry and idempotent re-post.
Retire `landed_cost_selftest` / `landed_cost_selftest_run` once these pass.

## Phase 6.3 — Weight / volume allocation bases (blocked)

Blocked on the product master carrying reliable net weight and volume. Those
bases must keep raising rather than silently allocating zero. Raise as a
product-domain change, not a landed-cost workaround.

## Phase 6.4 — Edge cases to confirm or close (added this session)

Each is verified against the engine first; only genuine gaps become work.
- Freight bill reversal or supplier credit note after the voucher is posted
  — does it force a landed-cost reversal, and is that enforced?
- Receipt reversal after capitalisation.
- Goods transferred or scrapped between receipt and posting.
- Voucher spanning receipts in more than one branch or warehouse.
- Re-post idempotency under concurrent requests (row locking on the
  voucher).

---

## Technical notes

- Canonical engines consumed, unchanged: `approval_route` / `approval_decide`,
  `resolve_exchange_rate` / `require_exchange_rate`,
  `inventory_apply_cost_revaluation`, `post_journal_entry_atomic`,
  `resolve_posting_account` + `default_account_settings`,
  `business_event_outbox`, the shared document/render pipeline, existing RLS.
- All lifecycle transitions stay server-side RPCs; the browser only requests
  operations.
- Checks after each unit: `npm run typecheck:landed-costs` and
  `npx vitest run src/test/architecture/landed-cost.test.ts`.
