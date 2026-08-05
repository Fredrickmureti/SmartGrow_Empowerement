# POS / Document Printing Latency — Live Plan (authoritative status)

Roadmap of record: `.lovable/plan/pos-printing-latency-architecture-audit-and-redesign-2026-08-05.md`
Verification verdict: `.lovable/plan/pos-printing-latency-verification-verdict-and-remaining-phas-2026-08-05.md`
This file is the live status board. Update it after every completed item.

Scope reminder: this is not POS-only. Sales, purchasing, inventory and warehouse
document output all run through the same `PrintService` → render → dispatch path,
so every change must keep those surfaces working.

## Currently active phase

**Phase 1R — Make the instrument real.** All engineering items are complete.
The only outstanding item is the exit criterion: capture real traces and write
the measured per-document latency table into this file.

## Completed and verified

- **1R.1** `print_traces` grants (`SELECT, INSERT` to `authenticated`, `ALL` to
  `service_role`, no `anon`) plus `(created_at DESC)` and `(label, created_at DESC)`
  indexes. `anon` execute revoked on the printing SECURITY DEFINER RPCs.
- **1R.2** Concurrency-safe tracer: `Map<correlationId, TraceContext>` replaces the
  module-global `current`. Correlation id threaded end-to-end — print entry →
  policy/ledger → render edge invoke/decode → device resolve → hardware exec →
  relay preflight/enqueue/agent round-trip. Guarded by
  `src/test/printing/trace-concurrency.test.ts`.
- **1R.3** Flush failures emit a `console.warn` instead of vanishing; still never
  thrown and never awaited on the hot path.
- **1R.4** Waterfall diagnostics view at `/settings/diagnostics/print-latency`:
  recent traces, per-span bars, totals, trace attributes.
- **1R.4b** p50/p95 per stage **per document type** in that view. Document type is
  derived from trace attributes (`kind_code` → `intent` → `source_doc_type` →
  label), with an end-to-end p50/p95 header and a per-stage p95-ranked table.
- **1R.5** Agent-side spans. `agent/src/routes/print.ts` reports
  `agent.printer_queue_wait` and `agent.printer_socket`; `agent/src/relay.ts`
  reports `agent.relay_queue_wait` and `agent.handler` and merges route spans via
  `attachAgentSpans`, carried back inside the job result as `_agent_spans`.
  `RelayTransport._absorbAgentSpans` replays them into the caller's trace with the
  correct correlation id and strips the key so route response shapes are unchanged.

Verification for this batch: `npx tsgo --noEmit` clean; `npx vitest run src/test/printing`
— 26 files, 162 tests, all green.

## Pending

1. **1R exit criterion (next task).** Collect real traces from the four document
   families — POS receipt, sales invoice, warehouse/inventory label, reprint — and
   write the measured p50/p95 per stage into this file. Phase 4 stays blocked until
   that table exists; if the printer socket rather than the cloud chain dominates,
   Phase 4 is re-scoped.
2. **Phase 4 — cut relay dead time.** Agent subscribes to `edge_jobs` over Realtime
   (poll stays as heartbeat fallback); cached presence replaces the liveness SELECT
   and queue-allowance COUNT on the hot path; per-endpoint FIFO queue and
   socket-close completion semantics stay untouched; prove the win with before/after
   `relay.preflight` and `relay.agent_roundtrip` percentiles.
3. **Phase 5 — one shape for every document.** Invoices, delivery notes, POs, GRNs,
   warehouse and inventory documents move onto the collapsed enqueue → drain path
   with non-blocking acknowledgement. Only `PostPaymentSurface` uses
   `startPrintDocument` today; every other surface still blocks on `printDocument`.
   Labels keep the client-side render but adopt the same acknowledgement and spans.
4. **Phase 6 — guardrails.** Architecture test: no render or dispatch on the
   checkout critical path. Architecture test: every `PrintService` stage is wrapped
   in a span and every entry point runs inside `withTrace`. Test: `print_traces` is
   insertable by an authenticated user. Regression test: acknowledgement is emitted
   before dispatch completes for every Phase 5 surface.

## Instructions for the next agent

1. **Verify before you build.** Confirm, against the codebase and the database, that
   the items under "Completed and verified" are actually true and enterprise-grade:
   tracer concurrency isolation, correlation id present at every span call site,
   agent spans arriving in `print_traces` for a real relay print, `print_traces`
   grants and RLS, and the diagnostics view rendering percentiles per document type.
   If anything fails verification, fix it before moving on and record the finding here.
2. **Then resume at the next milestone in order** — the 1R exit criterion (measured
   latency table), then Phase 4, then Phase 5, then Phase 6. Do not start Phase 4
   before the table exists.
3. Keep execution chronological; do not open unrelated work, leave partial features,
   or ship orphaned functionality. Bring each phase to a production-ready state.
4. Update this file immediately after each completed item.

## Technical notes

- The original roadmap's latency claims (labels 3–5 s, invoices 11–18 s, receipts
  ~21 s) are still **unmeasured** in this codebase. 1R exists so the redesign is
  driven by traces, not by that reading.
- Existing guards (`no-printservice-shim`, `no-raw-escpos-bytes`, hardware
  chokepoint, `no-direct-generate-document-in-pages`) must stay green.
