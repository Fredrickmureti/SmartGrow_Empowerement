# POS Printing Latency — Project Status (authoritative)

Roadmap of record: `.lovable/plan/pos-printing-latency-architecture-audit-and-redesign-2026-08-05.md`.
This file is the live status board. Update it after every implementation.

## Status at a glance

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Tracing seam + latency waterfall | Complete, verified |
| 2 | Non-blocking cashier acknowledgement | Complete, verified |
| 3 | Collapse the round trips | Complete, verified |
| 4 | Cut relay dead time | **Next** — not started |
| 5 | Same shape for invoices and labels | Not started |

Currently active phase: none in flight. Phase 3 landed in a coherent,
production-ready state; Phase 4 is the next milestone.

## Phase 1 — Measure (complete)

- `src/services/observability/trace.ts`: `withTrace` / `withSpan` /
  `annotateTrace`, correlation-scoped, fire-and-forget, never alters the
  wrapped result and never throws.
- `public.print_traces` table (correlation_id, label, total_ms, spans jsonb,
  attributes jsonb) with RLS scoped to the inserting user.
- Instrumented: `PrintService`, `render.ts`, `execForIntent`,
  `RelayTransport`, `dispatchPosReceipt`.
- Stage contract: `policy.resolve`, `ledger.open`, `render.source_pair`,
  `snapshot.fetch`, `document.ensure_record`, `intent.submit`,
  `intent.materialize_submit`, `intent.load_jobs`, `intent.resolve_org`,
  `intent.dispatch_job`, `job.claim`, `render.edge_invoke`, `render.decode`,
  `device.resolve`, `hardware.exec`, `relay.preflight`, `relay.enqueue`,
  `relay.agent_roundtrip`, `dispatch.copy`.

## Phase 2 — Unblock the cashier (complete)

- `PrintService` split into `planPrint` (policy + durable `print_jobs` rows)
  and `executePrint` (render → dispatch → ledger close).
- `startPrintDocument` resolves at acknowledgement and returns a background
  `completion` promise. `printDocument` keeps its old blocking semantics for
  every other caller.
- `usePrintJobStatus` follows the ledger rows over Realtime and collapses N
  copies into `queued` / `sent` / `printed` / `failed`.
- `PostPaymentSurface` acknowledges immediately, shows a Queued pill and
  takes its outcome from the ledger.
- Migration: `print_jobs` added to `supabase_realtime`, `REPLICA IDENTITY FULL`.
- Guardrail: `src/test/printing/non-blocking-acknowledgement.test.ts`.

## Phase 3 — Collapse the round trips (complete, this pass)

Delivered:

- **One RPC replaces four hops.** New
  `public.document_materialize_and_submit_intent(...)` (SECURITY DEFINER,
  `is_org_member` gated) runs `ensure_document_record` +
  `submit_document_intent` in a single transaction and returns the enqueued
  `print_jobs` rows plus `organization_id`. This removes the
  `ensure_document_record` RPC, the `submit-document-intent` Edge Function
  cold boot, the `loadJobs` SELECT and the `businesses` org SELECT from the
  interactive path.
- **Client seam:** `materializeAndSubmitIntent` in
  `src/services/documents/submitIntent.ts`; new PrintService entry
  `printSourceDocumentIntent`, traced as `intent.materialize_submit`.
- **One foreground drainer:** `printDocumentIntent` and
  `printSourceDocumentIntent` both delegate to the shared `drainIntentJobs`,
  so legacy and collapsed paths cannot drift.
- **Batched ledger close:** `public.print_jobs_settle(uuid[], bigint)` marks
  sent + acked for every copy in one call (parent fan-out promotion kept).
  `settleJobs` in `printing/jobs.ts`; `executePrint` calls it once per print
  instead of 2 RPCs per copy, fire-and-forget.
- **`dispatchPosReceipt`** now uses the collapsed path and accepts an
  already-loaded `frozen` snapshot so holders of it skip `snapshot.fetch`.
- **Architecture debt cleared:** added the sanctioned `PrintService.previewLabel`
  seam and moved `features/warehouse/lpn/lpnLabels.ts` onto it, fixing the
  pre-existing `printing-architecture` guard failure.

Verified:

- `npx tsgo --noEmit` clean.
- `src/test/printing` (26 files / 182 tests) and
  `src/test/architecture/printing-architecture.test.ts` all green.
- New guardrail `src/test/printing/round-trip-collapse.test.ts`: asserts one
  enqueue RPC, no Edge invoke, no `businesses` SELECT, and a single batched
  settle call.

Deliberately **not** done in Phase 3 (carry-forward, decide in Phase 5):

- Moving receipt ESC/POS rendering to sale-commit time. Phase 2 already took
  rendering off the cashier's blocking path, so the remaining win is small
  and it would mean a second formatter or a commit-time render worker.
  Re-evaluate once Phase 4 numbers land.
- `print_job_insert` still upserts on `(business_id, correlation_id)`, so N
  copies of a `printDocument` share one ledger row. Pre-existing behaviour,
  intentionally unchanged here.

## Phase 4 — Cut relay dead time (next)

Scope, unchanged from the roadmap:

1. Replace the agent's 1.5 s poll loop (`agent/src/relay.ts`,
   `POLL_INTERVAL_MS`) with a Realtime subscription on `edge_jobs` for the
   agent's workstation; keep the poll as a fallback heartbeat.
2. Remove the liveness SELECT and the queue-allowance COUNT from
   `RelayTransport`'s hot path — derive both from a cached workstation
   presence value refreshed by the heartbeat.
3. Keep the per-endpoint FIFO queue in `agent/src/routes/print.ts` and the
   socket-close completion semantics. Both are correct and must not be
   weakened.
4. Prove the win with the `relay.preflight` / `relay.agent_roundtrip` spans
   before and after.

## Phase 5 — One shape for every document (after Phase 4)

- Invoices reuse the collapsed enqueue → drain path
  (`printSourceDocumentIntent`).
- Labels keep the client-side render but adopt non-blocking acknowledgement
  and the same spans.
- Add the roadmap's remaining guardrails: no render/dispatch on the checkout
  critical path; every `PrintService` stage wrapped in a span.

## Instructions for the next agent

1. **Verify before you build.** Confirm Phase 3 is correct and
   enterprise-grade before touching Phase 4:
   - `npx tsgo --noEmit`.
   - `npx vitest run src/test/printing src/test/architecture/printing-architecture.test.ts`.
   - Read `document_materialize_and_submit_intent` in the database and check
     the org-membership gate, `search_path`, and that grants are limited to
     `authenticated` / `service_role`; same for `print_jobs_settle` and its
     `user_business_access` scoping.
   - Confirm no caller regressed: `printDocumentIntent` (legacy) and
     `printSourceDocumentIntent` must both end in `drainIntentJobs`.
2. **Then resume at Phase 4**, in the order listed above. Do not start
   Phase 5 or unrelated work until Phase 4 is coherent and production-ready.
3. **Update this file** as soon as each item lands: what is verified, what is
   pending, which phase is active, what comes next.
