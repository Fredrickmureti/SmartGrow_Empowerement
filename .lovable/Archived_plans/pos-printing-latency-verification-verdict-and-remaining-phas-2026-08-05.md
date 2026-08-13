# POS Printing Latency — Verification Verdict and Remaining Phases

Roadmap of record: `.lovable/plan/pos-printing-latency-architecture-audit-and-redesign-2026-08-05.md`.
This file is the live status board.

> Superseded as the live board by `.lovable/plan.md` (updated 2026-08-05, later).
> 1R.4b and 1R.5 are now complete; see that file for current status.

## Status board (updated 2026-08-05)

Done:
- 1R.1 grants + indexes on `print_traces`, `anon` execute revoked on the printing RPCs.
- 1R.2 concurrency-safe tracer (`Map<correlationId, TraceContext>`), correlation id
  threaded end-to-end: print entry -> policy/ledger -> render edge invoke/decode ->
  device resolve -> hardware exec -> relay preflight/enqueue/agent round-trip.
  Guarded by `src/test/printing/trace-concurrency.test.ts`.
- 1R.3 flush failures now warn instead of failing silently.
- 1R.4 waterfall view at `/settings/diagnostics/print-latency` (per-trace span bars,
  totals, slowest-stage rollup).

Pending:
- 1R.4b p50/p95 per stage per document type in the diagnostics view.
- 1R.5 agent-side spans (`agent/src/relay.ts`, `agent/src/routes/print.ts`) fed back
  through `addSpan`.
- 1R exit criterion: the measured per-document latency table is not written yet
  (needs real traces after the grants fix). Phase 4 stays blocked on it.
- Phase 4 (relay dead time), Phase 5 (all document surfaces on the collapsed
  non-blocking path; only `PostPaymentSurface` uses `startPrintDocument` today),
  Phase 6 (remaining guardrail tests).

## Phase 1 verification — code shipped, but it measures nothing (must be re-done)

Confirmed directly against the codebase and the database:

- `src/services/observability/trace.ts` exists, and `withSpan`/`withTrace` are
  wired into `PrintService`, `render.ts`, `execForIntent`, `RelayTransport`,
  `dispatchPosReceipt` (37 call sites across 8 files).
- `public.print_traces` exists with the documented columns and RLS scoped to
  `created_by = auth.uid()`.

Two defects mean the phase never delivered its actual output — a measured
latency budget:

1. **`print_traces` has no table grants at all.** `information_schema.role_table_grants`
   returns zero rows for it, so every browser insert is rejected. `flush()`
   swallows the error by design. Evidence: 42 print jobs in the last two days,
   **0 rows in `print_traces`**.
2. **No waterfall surface exists.** Nothing outside `PrintService`/`trace.ts`
   reads `print_traces`; the promised diagnostics view was never built.

A third issue is architectural: `trace.ts` keeps the active trace in a single
module-level `current` variable. Two concurrent prints (multi-copy receipts,
a label while an invoice is in flight) share or clobber one another's span
list. For a platform targeting many concurrent terminals this is a
correctness bug in the instrument itself.

**Verdict: Phase 1 is reopened.** Phases 2–5 were justified by reasoning, not
by numbers, exactly the thing the roadmap said it would not do.

## Phase 2 and 3 verification — genuinely landed

- `planPrint`/`executePrint` split, `startPrintDocument` returning an
  acknowledgement plus a background `completion` promise, `usePrintJobStatus`
  over Realtime, and `PostPaymentSurface` acknowledging on enqueue are all
  present. `print_jobs` and `edge_jobs` are both in `supabase_realtime`.
- `document_materialize_and_submit_intent`, `print_jobs_settle`,
  `ensure_document_record`, `print_job_insert` all exist as SECURITY DEFINER
  functions; `RelayTransport` now runs liveness and queue-allowance in
  parallel inside one `relay.preflight` span.
- One security gap to close: these SECURITY DEFINER RPCs are executable by
  `anon` as well as `authenticated`/`service_role`. Revoke `anon`.

## Phase 1R — Make the instrument real (do this first)

1. Migration: `GRANT SELECT, INSERT ON public.print_traces TO authenticated;`
   `GRANT ALL ... TO service_role;` (no `anon`), plus indexes on
   `(created_at DESC)` and `(label, created_at DESC)`.
2. Replace the module-global `current` with an explicit context that survives
   concurrency — a per-trace object passed through, or `AsyncLocalStorage` on
   the server side and an explicit handle on the client. Add a unit test that
   two overlapping `withTrace` calls keep disjoint span lists.
3. Make flush failures visible in dev: a single `console.warn` on insert
   error (still never thrown, never awaited on the hot path).
4. Build the waterfall view on the hardware diagnostics screen: recent traces
   by label, span bars, totals, p50/p95 per stage per document type.
5. Extend spans to the agent: `agent/src/relay.ts` and
   `agent/src/routes/print.ts` report claim → socket-open → socket-close, fed
   back through `addSpan` so the agent's share of the budget is visible.

**Exit criterion:** a measured per-document latency table (receipt, invoice,
label, reprint) taken from real traces, written into this file. Phase 4 is not
started until that table exists — if it shows the printer socket rather than
the cloud chain dominates, Phase 4 gets re-scoped.

## Phase 4 — Cut relay dead time (after Phase 1R numbers)

1. Agent subscribes to `edge_jobs` over Realtime for its workstation
   (`edge_jobs` is already in the publication); the 1.5 s poll stays as a
   fallback heartbeat only. Removes up to 1.5 s of claim latency.
2. Drop the liveness SELECT and queue-allowance COUNT from the hot path in
   favour of a cached presence value refreshed by the heartbeat.
3. Keep the per-endpoint FIFO queue and socket-close completion semantics
   untouched.
4. Prove the win with before/after `relay.preflight` and
   `relay.agent_roundtrip` percentiles.

## Phase 5 — One shape for every document

- Invoices, delivery notes, POs, GRNs, warehouse and inventory documents move
  onto the collapsed enqueue → drain path with non-blocking acknowledgement.
  Today only `PostPaymentSurface` uses `startPrintDocument`; every other
  surface still blocks on `printDocument`.
- Labels keep the client-side render but adopt the same acknowledgement and
  spans.
- Revoke `anon` execute on the printing SECURITY DEFINER RPCs.

## Phase 6 — Guardrails (new, was missing)

- Architecture test: no render or dispatch on the checkout critical path.
- Architecture test: every `PrintService` stage is wrapped in a span, and
  every print entry point runs inside a `withTrace`.
- Test: `print_traces` is grantable and insertable by an authenticated user —
  the exact failure that silently voided Phase 1.
- Regression test: acknowledgement is emitted before dispatch completes for
  every surface migrated in Phase 5, not just POS.

## Technical notes

- Latency claims in the original roadmap (labels 3–5 s, invoices 11–18 s,
  receipts ~21 s) remain **unmeasured** in this codebase. They are consistent
  with the serialized-hop reading, but Phase 1R exists precisely so the
  redesign is driven by traces rather than by that reading.
- Existing guards (`no-printservice-shim`, `no-raw-escpos-bytes`, hardware
  chokepoint, `no-direct-generate-document-in-pages`) must stay green.
