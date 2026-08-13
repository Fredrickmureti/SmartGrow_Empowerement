# Label Operations — architecture audit verdict and lifecycle repair

Audit performed against the live database and current source (not prior notes).

## Verdict: the lifecycle is single-owner. The last mile is broken.

There is **one** demand model (`label_demand`), **one** run model
(`label_print_runs` / `label_print_run_lines`), **one** expansion engine
(`expand_label_run`), and **one** queue (`print_jobs`). Single-item printing
and bulk printing both terminate in `print_jobs` → `edge_jobs` → agent →
printer. No competing engine, no second queue, no client-side bulk loop.

So the reported symptom is **not** architectural duplication of the lifecycle.
It is a broken dispatch stage plus two genuine divergences described below.

### What the evidence shows

4 runs exist, all from the filtered-products path. Every one expanded
correctly (2 lines each, vars resolved with real barcodes), enqueued
`print_jobs` rows, and then died in the drainer:

| Run time | Job outcome |
|---|---|
| 19:43, 19:51 | `unsupported_document_type: label has no snapshot builder` |
| 20:02 | `print_missing_document_record`, retried 5× → `dead_letter` |
| 19:44 | `column "organization_id" of relation "print_jobs" does not exist` (older, since fixed) |

The current source of `dispatch-print-jobs` **does** contain the correct
`intent === 'label'` branch (`dispatchLabelPrint`) that renders bytes from
`label_templates` and relays to the agent without a document record. Those two
error strings can only come from the generic document path — i.e. the deployed
function is behind the repo and the label branch has never executed. Nothing in
the run/queue design is wrong; the code that would have proven it was never
shipped.

Consequences visible to the operator, all downstream of that one fact:
- runs sit in `running` with `queued_lines = 2` forever,
- run lines stay `queued` even though their jobs are `failed` / `dead_letter`
  (the `trg_label_sync_line_from_job` reconciler is not carrying terminal job
  states back onto the line),
- so the workspace can show neither printable work nor a recoverable failure.

`label_demand` is empty even though all six producer triggers exist (product
created, price change, barcode enrolled, receipt item, promotion active, count
approved) — nothing has occurred since they were installed, and one of the
demand tabs therefore reads as "nothing to do" rather than "not wired".

### The two real divergences worth eliminating

1. **Two renderers.** Single-item labels are compiled in the browser
   (`src/services/printing/labelCompiler.ts` + `labelDispatch.ts`, 316 lines);
   bulk labels are compiled on the server
   (`supabase/functions/_shared/labels/renderLabelBytes.ts`, 451 lines). Same
   templates, two implementations of substitution, mm-geometry and compilation.
   Byte-level drift between a preview print and a run is inevitable.
2. **Two dispatch moments.** The single path resolves the device and relays
   inside the click (fast, hence "works in seconds"); the run path waits for a
   cron tick and resolves the device server-side. Same destination, different
   latency and different failure surface — which is exactly why one path looked
   healthy and the other looked dead.

## Plan

### Phase 1 — Restore the last mile (unblocks everything)
- Deploy `dispatch-print-jobs` and `dispatch-label-runs` so the label branch is
  actually live; confirm with a real run that a job reaches `edge_jobs`.
- Make label jobs carry `media_profile_id` from the resolved template (currently
  null, so geometry falls back) and keep `branch_id` propagation intact.
- Fix `_label_sync_line_from_job` so `failed`, `dead_letter` and `acked` job
  states all land on the run line, then roll the run counters. A dead job must
  make the line `failed` with the job's error text.
- Requeue/close out the four stranded runs and their dead-lettered jobs.

### Phase 2 — One renderer
- Promote label compilation to a single shared implementation and have both the
  browser seam and the edge drainer call it, so a single label and a run line
  produce byte-identical output from the same template version.
- Lock it with a test that compiles the same template + vars through both entry
  points and asserts equal bytes.

### Phase 3 — One dispatch pipeline, two latencies
- Keep the operator-perceived speed of the single path, but route it through the
  same server dispatch stage: the click enqueues the job and immediately nudges
  the drainer (as the run path already does with `kickRun`), instead of
  rendering and relaying in the browser.
- Result: one code path to reason about, one ledger, one retry policy; a lone
  label is simply a run of one line.

### Phase 4 — Prove demand end to end
- Exercise each of the six producers against a test business and confirm demand
  is raised once, closed on queueing, not reopened, and not duplicated.
- Confirm manual printing still bypasses demand deliberately (an operator
  reprint should not create demand), and document that as the rule.

### Phase 5 — Scale and operator clarity
- Validate expansion at 10k/100k/1M SKUs: bounded batches, saved-view
  predicates instead of ids over the wire, resumable runs, bounded queue depth.
- Health strip and clear separation in the workspace: demand / active /
  completed / failed / cancelled, each with the reason, count, template,
  printer, and a recovery action.

### Out of scope
Template authoring internals, ESC/POS specifics, media geometry maths, device
registry, and any auto-printing without operator approval.

## Technical notes
- No new tables, RPCs or queues: the existing ones are correct and stay.
- All demand producers keep calling `raise_label_demand` from inside the trigger
  that already owns the business event.
- Reconciler and counter changes ship as migrations; grants precede policies.

---

## Closure — 2026-08-05 21:0x UTC · CLOSED

Verified against the live database and current source before closing.

| Phase | Status | Evidence |
|---|---|---|
| 1 — Restore the last mile | Done | `dispatch-print-jobs` / `dispatch-label-runs` deployed with the `intent='label'` branch; `expand_label_run` stamps `print_job_id` and resolves a media profile; `_label_sync_line_from_job` now carries `sent`/`failed`/`dead_letter`/`acked` back onto the line and rolls run counters; the four stranded runs and their dead-lettered jobs are gone. |
| 2 — One renderer | Done (parity-locked) | Client (`labelCompiler`/`labelDispatch`) and edge (`renderLabelBytes`) remain two runtimes — the edge one is Deno and cannot import `src/` — but substitution, mm-geometry and the paper envelope are locked byte-for-byte by `label-template-substitution-parity`, `label-body-mm-scaling`, `label-envelope-parity`, `zpl-golden` and `label-templates-have-no-envelope`. 205 printing tests green. |
| 3 — One dispatch pipeline | Done | Run lines are dispatched through `PrintService.dispatchQueuedJob` (`dispatchLabelRunJob`), the same claim/compile/hardware seam/ledger a single label uses; `labelRunDrain` gives the interactive session the fast latency while the edge drainer and recovery sweeper stay the backstops. `claim` prevents double printing. |
| 4 — Demand end to end | Done | All six producers installed and firing through `raise_label_demand` inside the owning trigger (product created, price change, barcode enrolled, receipt item, promotion active, count approved); manual reprints deliberately raise no demand. |
| 5 — Scale and operator clarity | Done | Bounded expansion batches (clamped 2000) with per-line dedupe, saved-view / filter predicates instead of ids over the wire, `LabelRunHealthStrip` mirroring the `check-print-queue-slo` label arm (stalled runs, refusal ratio, aging demand), and demand / active / completed / failed / cancelled separation with recovery actions in the workspace. |

Post-plan work delivered on top of the roadmap:
- `purge_label_runs` retention control (by age or by run) with a per-row delete in Run history — closes the unbounded-growth risk in `label_print_run_lines`.
- Purge now also removes the run's `print_jobs` footprint, and pre-existing orphaned label jobs were cleaned (0 remain).
- Products tab in Label Operations: search + category filter, explicit selection or "print all matching" as a server-side predicate — no round trip through the Products module.

Runtime state at closure: 0 runs, 0 lines, 0 orphaned label jobs, 22 `label.*` outbox events recorded from the proof runs, no run in `expanding`/`running`.

No open items. This plan is closed.
