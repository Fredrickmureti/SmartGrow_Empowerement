# Label Operations Engine — verification verdict + Phase 6 completion

Source roadmap: `.lovable/plan/label-operations-from-per-product-buttons-to-a-demand-driven-2026-08-05.md`
(audit verdict + target architecture; unchanged and still binding).

Verification performed: 2026-08-05 (new owner, independent audit).

## Phase 1–5 verification verdict: CLAIMS HOLD (structurally), UNPROVEN (at runtime)

Checked directly against the live database and codebase, not the previous notes:

| Claim | Verdict |
|---|---|
| `label_demand`, `label_print_runs`, `label_print_run_lines` exist with RLS | Confirmed (RLS enabled, one business-scoped policy each) |
| `create_label_run`, `expand_label_run`, `claim_label_runs`, `set_label_run_status`, `retry_label_run_failures`, `recount_label_run`, `raise_label_demand` | Confirmed, all present with the documented signatures |
| `expand_label_run` supports 4 selection kinds, bounded batches, dedupe | Confirmed in source: `product_ids`, `product_filter`, `demand`, `location_ids`; batch clamped to 2000; per-line `NOT EXISTS` guard |
| Demand triggers (price change, barcode enrollment, goods receipt) | Confirmed on `products`, `product_identifiers`, `goods_receipt_items` |
| `label.` topic + run event emitter | Confirmed (`business_event_topics` row, `trg_label_run_emit_event`) |
| `dispatch-label-runs` cron | Confirmed, scheduled every minute and active |
| `dispatch-print-jobs` handles `intent='label'` | Confirmed |
| Client seams: `useLabelRuns`, Label Operations workspace, `BinLabelDialog` re-pointed, `PrintFilteredLabelsButton`, coverage guard test | Confirmed, all files present and wired into inventory routes + nav |

**The one material finding:** the engine has never executed. `label_print_runs`,
`label_print_run_lines` and `label_demand` are all empty, and no `label.*` event has
ever reached the outbox. Everything above is verified as *built*; nothing is verified
as *working*. Phase 6 item 1 is therefore the correct and mandatory next step, exactly
as the previous engineer stated.

No regressions or duplicate print paths found: single-item printing still flows through
`useLabelPrint`, batch paths through `useLabelRunActions`, and the guard test enforces it.

**Second finding (new):** the Phase 5 UI does not typecheck. `PrintFilteredLabelsButton`
declares its template table with an untyped `workflow` string, so it fails against
`PrinterWorkflow`. The previous engineer's "typecheck clean" claim does not hold.

## Phase 6 — Hardening and proof (execution order)

0. **Fix the broken build.** Type the template table in `PrintFilteredLabelsButton` against
   `PrinterWorkflow` so the workflow is checked at compile time, and confirm the whole label
   surface typechecks clean before any new work lands.
1. **End-to-end proof.** Seed a synthetic run of ≥1,000 product lines in a test business;
   drive `expand_label_run` through repeated passes; assert: bounded passes, lines created
   once under repeat calls, `print_jobs` rows written with `intent='label'` and deterministic
   dedupe keys, refused lines carry a reason, counters roll the run to `completed`, and
   `business_event_outbox` receives `label.run.submitted` / `label.run.completed`. Record the
   evidence in this file and clean up the synthetic rows.
2. **Run SLO + observability.** Extend `check-print-queue-slo` with a label-run arm: alert on
   runs stuck in `expanding`/`running` beyond a threshold, on a high `refused_lines` ratio,
   and on demand aging without a run. Surface the same signals as a health strip on the
   Label Operations workspace.
3. **Demand coverage completion.** Wire the three missing producers to `raise_label_demand`:
   **product import completion**, **promotion activation**, **physical-count approval** —
   reusing the existing completion paths for each rather than adding new event plumbing.
4. **Saved-view selection.** Extend the `product_filter` predicate so a saved product view can
   be submitted as the run selection (no ids through the browser at 2M SKUs).
5. **Retention and growth control.** `label_print_run_lines` is the highest-cardinality table in
   the subsystem (50k lines per run). Add a retention policy: purge completed run lines past a
   configurable age while keeping the run header and counters as the audit record.
6. **Bulk caller sweep close-out.** PackStation pallet/shipping and mobile receiving currently
   print one carton at a time through the sanctioned per-entity seam, which is correct. Add a
   "label all cartons in this shipment" run submission where the operator today clicks N times,
   and extend the coverage guard test to lock in the outcome.

Out of scope, unchanged: rendering internals, ESC/POS, media geometry, device registry,
readiness, and any auto-printing without operator approval.

## Technical notes

- All new demand producers must call `raise_label_demand` inside the existing trigger/RPC that
  already owns the business event; no new client-side calls, no duplicated business rules.
- The retention purge belongs in SQL (a scheduled function), not in an edge function loop.
- Every schema change ships as a migration with GRANTs before RLS policies.
- Proof work in item 1 runs against a test business and leaves no residue.
