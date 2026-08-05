# Label Operations Engine — authoritative project status

Source roadmap: `.lovable/plan/label-operations-from-per-product-buttons-to-a-demand-driven-2026-08-05.md`
(audit verdict + target architecture; unchanged and still binding).

Last updated: 2026-08-05.

## Current phase

**Phase 5 — Client seams and UI: COMPLETE.** The engine is end-to-end.
Next active phase: **Phase 6 — Hardening and proof** (not started).

## Fully implemented and verified

### Phase 1 — Domain model (done)
- `label_demand`, `label_print_runs`, `label_print_run_lines` with GRANTs, RLS scoped by
  business access, counters and timestamps.
- Coalescing unique key on open demand so repeated events do not fan out.

### Phase 2 — Expansion engine (done)
- `create_label_run`, `expand_label_run(run_id, batch_size)`, `claim_label_runs`,
  `set_label_run_status`, `retry_label_run_failures`, `recount_label_run`.
- `expand_label_run` supports selections: `product_ids`, `product_filter`, `location_ids`,
  `demand`. Bounded batches (max 2000/pass), idempotent, resumable.
- Lines with no printable identity are marked `refused` with a reason — never labelled with
  a SKU or UUID fallback (ADR-0089).
- Jobs enqueued into the existing `print_jobs` ledger with deterministic dedupe keys
  (`label_run:<run>:<entity>`); the existing drainer is untouched.
- `dispatch-label-runs` edge function (pg_cron every minute + operator nudge, dual-auth:
  service role for cron, RLS-scoped client for manual triggers, `MAX_PASSES_PER_RUN` cap).
- `dispatch-print-jobs` extended with a `label` intent: renders bytes server-side via
  `supabase/functions/_shared/labels/renderLabelBytes.ts` (ZPL/EPL envelope injection from
  the resolved media profile) and relays through `edge_jobs`.

### Phase 3 — Event fabric (done)
- Demand triggers: price change, barcode enrollment, goods receipt → `raise_label_demand`.
- `label.` topic registered in `business_event_topics` (producer `inventory`).
- `_label_run_emit_event` trigger publishes `label.run.submitted|completed|failed|cancelled`
  to `business_event_outbox` with an idempotency key. Verified against the real outbox
  column set (`org_id`, `event_type`, `source_doc_type`, `source_doc_id`, `idempotency_key`).

### Phase 4 — Client seams (done)
- `src/hooks/inventory/useLabelRuns.ts`: `useLabelRuns`, `useLabelRunLines`, `useLabelDemand`,
  `useLabelRunActions` (create / pause / resume / cancel / retry-failed / dismiss demand).
- `useLabelPrint` unchanged for single-item prints; refusal rules and missing-device CTA
  preserved, all existing callers and guard tests still pass.

### Phase 5 — UI (done)
- `/inventory-app/labels` — Label Operations workspace: demand by reason, run composer,
  live progress, pause/cancel/retry, per-line failure and refusal reasons. Registered in
  inventory routes and sidebar nav.
- `BinLabelDialog` re-pointed at the engine: the per-location client `for` loop is deleted;
  it now submits one `location_ids` run and navigates to the workspace.
- Products grid toolbar gains `PrintFilteredLabelsButton` — submits the *current filter* as a
  predicate (`product_filter`), so a 2M-SKU catalogue never ships ids through the browser.
- Guard test in `src/test/printing/label-coverage.test.ts`: batch entry points must use
  `useLabelRunActions` and must not contain a client print loop. 22 tests pass.

## Pending work — Phase 6 (next)

Bring the engine to proven production readiness. In order:

1. **End-to-end proof.** Submit a real run of ≥1,000 lines against a test business and prove:
   expansion completes in bounded passes, `print_jobs` receive `intent='label'`, the drainer
   renders and relays, counters roll up to `completed`. Record the evidence.
2. **Run SLO + observability.** Extend `check-print-queue-slo` (or add a label-run sibling) to
   alert on runs stuck in `expanding`/`running` past a threshold, and on `refused_lines` ratio.
3. **Demand coverage completion.** The roadmap lists six producers; three are wired
   (goods receipt, price change, barcode enrollment). Still missing: **product import
   completion, promotion activation, physical-count approval**.
4. **Remaining bulk callers.** Sweep for any other multi-entity label paths (PackStation
   pallet/shipping batches, mobile receiving) and re-point any that batch client-side.
5. **Saved-view selection.** Allow a saved product view to be used as the run predicate
   (`product_filter` extension), as described in the roadmap.

Out of scope, unchanged: rendering internals, ESC/POS, media geometry, device registry,
readiness, and any auto-printing without operator approval.

## Instructions for the next agent

1. **Verify before building.** Do not start Phase 6 item 1 until you have re-checked the
   Phase 1–5 claims above against the live system:
   - `expand_label_run` handles all four selection kinds and is idempotent under repeat calls.
   - `dispatch-label-runs` cron job exists and is enabled; `dispatch-print-jobs` handles the
     `label` intent without touching `document_artifacts`.
   - `_label_run_emit_event` actually writes to `business_event_outbox` on a real run insert
     (insert a run in a test business and read the outbox row back).
   - RLS on the three label tables blocks cross-business reads.
   - `bunx vitest run src/test/printing/label-coverage.test.ts` passes and `tsgo --noEmit` is
     clean for the label files.
   Record the verdict at the top of this file before changing code.
2. **Then resume at Phase 6 item 1** — end-to-end proof — and work the list in order. Do not
   jump to UI polish or unrelated subsystems.
3. **Update this file immediately after each item**, moving it from Pending to Implemented
   with the evidence that proves it.
