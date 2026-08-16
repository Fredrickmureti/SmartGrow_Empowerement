# Landed Cost Domain — Verification Verdict & Remaining Engineering

Last updated: 2026-08-16 (new owner handoff) · Active phase: **B (final item)**

## Phase 1 — Independent verification of the previous engineer's claims

Checked directly against the live database and the working tree, not against notes.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| One writer per operation, no duplicate engines | Confirmed | `landed_cost_allocate_voucher`, `landed_cost_post_voucher`, `_landed_cost_post_apply`, `landed_cost_reverse_voucher` — exactly one overload each; same for `inventory_apply_cost_revaluation`, `inventory_reverse_cost_revaluation`, `inventory_sync_avco_from_layers`, `inventory_cost_layer_descendants` |
| Phase A lifecycle executed on live data | Confirmed | 1 voucher, status `reversed`, 1 allocation row — a real allocate → post → reverse cycle, not an empty table |
| Valuation left clean after the cycle | Confirmed | `check_inventory_valuation_drift()` returns 0 rows |
| Receipt-reversal guard landed | Confirmed | `landed_cost_receipt_encumbrance`, `landed_cost_receipt_block_reason`, `landed_cost_assert_receipt_unencumbered`, `_landed_cost_annotate_reversal_intent` all exist as single functions; `resolve_reversal_intent` is annotated, not forked |
| Workspace reachable | Confirmed | `src/apps/purchases/routes.tsx` wires list / new / `:id` / component-types to `src/features/purchases/landed-costs/*`; the interim `src/pages/purchases/LandedCosts.tsx` shell is gone |
| Transfer lineage proven | Partially confirmed | Code and ratchet exist, but `cost_layer_lineage` and `stock_transfers` are both empty — the proof is a rolled-back rehearsal only, and the **reversal** half across two warehouses was never asserted |
| `landed_cost_selftest` retired | Not done | `landed_cost_selftest` and `landed_cost_selftest_run` still exist in `public` — a second, non-canonical verification path |
| List KPIs read canonical server data | Not correct | `LandedCostListPage` computes KPIs in the browser via `landedCostKpis(rows)` / `useMemo` over fetched voucher rows, while `landed_cost_clearing_exposure`, `landed_cost_receipt_summary` and `landed_cost_valuation_attribution` exist server-side and go unused there |

Verdict: the domain is genuinely reconstructed and canonically integrated. Three real gaps remain, plus one deliberately blocked item.

## Phase 2 — Remaining work, in dependency order

### B1 — Supplier credit note against a landed-cost bill (last Phase B item)
A freight/duty bill can be credited after the voucher is posted. Decide and enforce one rule: **block the credit note while the voucher still encumbers inventory, recommending voucher reversal** — consistent with the goods-receipt decision, because a posted voucher is an approved accounting document with its own governance route. Implementation:
- extend `landed_cost_receipt_encumbrance` usage to bill scope (a bill-level encumbrance read over the same allocation truth, no second authority);
- annotate the existing `vendor_credit_note` reversal-intent resolver the same way `resolve_reversal_intent` was annotated — do not fork it;
- guard at credit-note draft creation and again at confirmation/posting, so Landed Cost Clearing can never be relieved twice;
- ratchet `supabase/tests/landed_cost_credit_note_guard_test.sql`; write-up in `docs/audit/`.

### B2 — Close the transfer-reversal hole found in verification
`inventory_apply_cost_revaluation` stamps `warehouse_id` per revaluation row, but `inventory_reverse_cost_revaluation` never reads it. Rehearse (rolled back): receive → transfer part of the stock → post → **reverse**, and assert both origin and destination layers return to their pre-landed-cost unit cost, AVCO is re-derived per warehouse, the reversal journal splits inventory vs COGS correctly across warehouses, and drift stays zero in both scopes. Any defect is fixed in the canonical revaluation engine, not in landed cost. Extend `landed_cost_transfer_lineage_test.sql` with the reversal assertions.

### C — Retire the parallel verification path
Move any assertion only `landed_cost_selftest` covers into `supabase/tests/landed_cost_*`, drop both functions, and add a probe asserting they stay dropped.

### D — Physical allocation bases (stays blocked, by design)
Weight / volume remain refused until the product master carries canonical net weight and volume with UoM, normalised through the existing UoM engine. Keep the refusal explicit and the message actionable. No local conversion formulas, no fabricated dimensions.

### E — Operator comprehension pass on the workspace
Replace the browser-side KPI aggregation with the existing server-side reporting RPCs so there is one truth. The workspace must answer, without database vocabulary: what needs allocating, what awaits approval, what is ready to post, how much value is being added and where, what is sitting in clearing, and what happened after posting. Read-only; no client-side financial calculation.

## Technical notes

- No new engines. FX, UoM, approvals, valuation, accounting, events, documents and audit stay canonical; landed cost is a consumer.
- Rehearsal pattern: a `DO $$ ... $$` migration that clones the voucher, exercises the lifecycle and ends in `RAISE EXCEPTION` so nothing persists while results return in the error text. Clone the voucher id (`post_journal_entry_atomic` deduplicates by `(source_type, source_id)`) and give the clone a different `created_by` than the posting actor or `guard_landed_cost_self_approval` refuses. `landed_cost_reverse_voucher` needs `auth.uid()`, so drive the posting half through `_landed_cost_post_apply`.
- `supabase--read_query` runs without EXECUTE on the `landed_cost_receipt_*` helpers; exercise them from a migration.
- Every change lands with a SQL ratchet in `supabase/tests/` plus an audit write-up, and this file is updated after each completed item.
