# POS / Document Printing Latency — Live Plan (authoritative status)

Roadmap of record: `.lovable/plan/pos-printing-latency-architecture-audit-and-redesign-2026-08-05.md`
This file is the live status board. Update it after every completed item.

Scope reminder: not POS-only. Sales, purchasing, inventory, warehouse and HR
document output all run through the same `PrintService` → render → dispatch path.

## Verification of the previous engineer's claims (done this session)

Confirmed true in the codebase:

- Tracer `src/services/observability/trace.ts` with per-correlation-id context;
  `withTrace`/`withSpan` wired through `PrintService`, `render`, `execForIntent`,
  `RelayTransport`, `dispatchPosReceipt`.
- Diagnostics waterfall page exists (`src/pages/diagnostics/PrintLatency.tsx`,
  routed) — 1R.4 / 1R.4b claims hold.
- Agent spans exist: `attachAgentSpans` / `_agent_spans` in `agent/src/relay.ts`
  and `RelayTransport._absorbAgentSpans`.
- Phase 4.1 long-poll: `wait_ms` + `claimBatch` in
  `supabase/functions/edge/routes/agent-poll.ts`, agent sends `wait_ms`.
- Phase 4.2 cached presence, no queue `count(*)` in `RelayTransport`.
- Phase 2 non-blocking entry `startPrintDocument` exists and only
  `PostPaymentSurface` uses it — matching the plan's own admission.

New findings that change the remaining work (measured from `print_jobs`,
30-day window, this session):

1. **The ledger is not settling.** Of the last 30 days of rows, a large share are
   stranded: `sales.invoice` pdf 31 rows at `sent`, legacy `invoice` 26 at `sent`
   and 23 at `failed`, plus `dead_letter` rows across `sales.invoice`,
   `sales.delivery_note`, `sales.order_ack`, `sales.estimate`, `hr.contract`,
   `pos.receipt_customer`. Any measurement built on `acked_at` is therefore
   biased to the minority of prints that completed. This is a correctness defect
   in the audit trail, not only a latency one.
2. **PDF "latency" is mostly the OS print dialog.** `acked` pdf rows sit at
   ~65–68 s because `toPage()` awaits `printPdfInPage`, which resolves only after
   the operator dismisses the host dialog. The ledger conflates operator think
   time with system latency, and the calling surface stays blocked for all of it.
   PDF needs a distinct terminal state (`handed_to_host`) rather than `acked`.
3. **Escpos is already close to target on the wire.** `acked` escpos rows:
   `sales.invoice` p50 ~4.2 s, `pos_receipt` ~3.7 s, labels ~1.0 s. The remaining
   escpos cost is enqueue-side and blocking-UI, which is exactly what Phase 5
   removes — no further relay work is justified beyond 4.4.
4. **Every non-POS surface still blocks.** `printDocumentIntent` /
   `printSourceDocumentIntent` await `drainIntentJobs`, which awaits claim →
   render → device resolve → dispatch per job. ~40 call sites (Invoices, Estimates,
   Delivery Notes, POs, Bills, GRNs, WMS labels, payroll, HR letters) sit behind
   that await, plus `usePrintWithFallback` and `useRecordPrint`.

## Remaining phases

### Phase 4.4 — prove the relay win (small)
Re-measure `relay.preflight` / `relay.agent_roundtrip` percentiles from
`print_traces` once a long-poll agent build runs on a workstation. Blocked on an
agent deployment; do not hold Phase 5 for it.

### Phase 5 — one shape for every document (main work)
5.1 **Non-blocking core.** Give the intent entries the same two-moment shape as
`startPrintDocument`: `startPrintDocumentIntent` / `startPrintSourceDocumentIntent`
return once the ledger rows exist, with a `completion` promise. One shared
implementation — no parallel drainer.

5.2 **One acknowledgement surface.** A `usePrintDispatch` hook (wrapping the
start* entries) that toasts "queued" immediately and then follows the `print_jobs`
rows over Realtime to a success/failure toast. `printOutcomeToast` gains queued
and per-row terminal variants so copy stays honest.

5.3 **Migrate the surfaces** in order: sales pages and `useRecordPrint` →
purchases → warehouse/inventory documents and labels → payroll/HR. Each surface
loses its `await` and its optimistic toast; `usePrintWithFallback` keeps the
fallback dialog but drives it from the terminal ledger row instead of a blocked
promise.

5.4 **Fix PDF terminal semantics.** Split the pdf disposition: mark
`handed_to_host` when the artifact reaches the host dialog and settle from there,
so dialog time never counts as system latency and pdf rows stop stranding at
`sent`. Keep download disposition settling immediately.

5.5 **Drain the stranded backlog.** Extend the recovery sweeper (and a one-off
migration) to age out rows stuck at `sent` beyond the abandon window into
`failed`/`dead_letter` with a reason, so the ledger and the diagnostics
percentiles describe reality.

### Phase 6 — guardrails
- Architecture test: no render or dispatch awaited on an interactive handler path
  (checkout and every migrated surface).
- Architecture test: every `PrintService` stage wrapped in a span; every entry
  point inside `withTrace`.
- Test: `print_traces` insertable by an authenticated user.
- Regression test: acknowledgement emitted before dispatch completes, per surface.
- Existing guards stay green (`no-printservice-shim`, `no-raw-escpos-bytes`,
  hardware chokepoint, `no-direct-generate-document-in-pages`).

## Targets

| Stage | Target |
| --- | --- |
| Acknowledgement after operator click | < 500 ms |
| Bytes leave the browser (escpos) | < 1 s |
| Printer begins printing | < 1.5 s |
| Full cashier workflow | < 2 s |

## Completed and verified (previous sessions, re-confirmed)

1R.1 grants + indexes on `print_traces`; 1R.2 concurrency-safe tracer with
end-to-end correlation id; 1R.3 flush warnings; 1R.4 waterfall view; 1R.4b p50/p95
per stage per document type; 1R.5 agent-side spans; Phase 2 `startPrintDocument`
(POS only); Phase 3 single-RPC materialize+submit and batched
`print_jobs_settle`; Phase 4.1–4.3 long-poll claim, cached presence, FIFO/socket
semantics untouched.

## Instructions for the next agent

1. Execute Phase 5 in the 5.1 → 5.5 order; do not start Phase 6 before the
   surfaces exist to guard.
2. After each item: `npx tsgo --noEmit` and `npx vitest run src/test/printing`,
   then update this file.
3. Delete the blocking code paths you replace — no shim layer, no second drainer.
