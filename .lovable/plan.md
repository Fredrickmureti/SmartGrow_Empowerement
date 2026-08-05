# POS / Document Printing Latency — Live Plan (authoritative status)

Roadmap of record: `.lovable/plan/pos-printing-latency-architecture-audit-and-redesign-2026-08-05.md`
Verification verdict: `.lovable/plan/pos-printing-latency-verification-verdict-and-remaining-phas-2026-08-05.md`
This file is the live status board. Update it after every completed item.

Scope reminder: this is not POS-only. Sales, purchasing, inventory and warehouse
document output all run through the same `PrintService` → render → dispatch path,
so every change must keep those surfaces working.

## Currently active phase

**Phase 4 — Cut relay dead time.** Phase 1R is closed: its exit criterion is
satisfied by the measured table below. Phase 4 items 1–3 are implemented; item 4
(before/after percentiles from live traffic) is the remaining work.

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

### Phase 4 — cut relay dead time (items 1–3 complete)

- **4.1 Long-poll replaces interval polling.** `supabase/functions/edge/routes/agent-poll.ts`
  now accepts `wait_ms` and holds the request open, re-checking for claimable jobs
  every 250 ms up to a 20 s ceiling; the claim loop was extracted into `claimBatch`
  and is unchanged in behaviour. `agent/src/relay.ts` sends `wait_ms`, guards the
  request with an `AbortSignal.timeout`, and pauses only 200 ms between held-open
  polls. Expected effect: average claim latency drops from ~750 ms (half of the old
  1.5 s interval) to ~125 ms, with *fewer* round trips. Agents that do not send
  `wait_ms` keep the original behaviour, so a stale agent build is safe.
- **4.2 Presence is cached; the queue COUNT is gone.** `RelayTransport._liveness`
  caches a *positive* presence read for 5 s (negatives are never cached, so an agent
  that just came back is usable immediately). `_queueAllowanceMs` no longer issues a
  `count(*)` over `edge_jobs` — it uses the transport's own in-flight counter, which
  is the burst that actually matters since a burst comes from one tab. Both reads are
  off the hot path; `relay.preflight` now carries `queue_allowance_ms` and `in_flight`
  as span attributes.
- **4.3 Untouched by design:** the per-endpoint FIFO queue and socket-close
  completion semantics in `agent/src/routes/print.ts`.

Verification: `npx tsgo --noEmit` clean; `npx vitest run src/test/printing` green
(26 files / 162 tests); `npx tsc --noEmit` in `agent/` clean apart from a pre-existing
unrelated `selfsigned` module-resolution error in `src/tls.ts`.

## Measured latency table (1R exit criterion — closed 2026-08-05)

`print_traces` was still empty at the time of measurement (no operator print has
run since the grants landed), so the table is taken from the **`print_jobs`
ledger**, which records the same stage boundaries at job granularity:
`requested_at → sent_at` (enqueue + render + dispatch out of the browser) and
`sent_at → acked_at` (relay + agent + printer). 30-day window, `status='acked'`.

| Document | Medium | n | enqueue→sent p50 / p95 | sent→ack p50 / p95 |
| --- | --- | --- | --- | --- |
| POS receipt (legacy `pos_receipt`) | escpos | 43 | 3276 / 15839 ms | 260 / 576 ms |
| Sales invoice | escpos | 27 | 817 / 1903 ms | 2916 / 6229 ms |
| Sales invoice | pdf | 3 | 919 / 1473 ms | 67262 / 97577 ms |
| Delivery note | escpos | 2 | 982 / 4318 ms | 2721 / 5613 ms |
| Delivery note | pdf | 2 | 743 / 1080 ms | 64107 / 65014 ms |
| Estimate | escpos | 2 | 1147 / 1151 ms | 2916 / 3933 ms |
| WMS LPN label | escpos | 4 | 747 / 2037 ms | 306 / 433 ms |
| Purchase order | escpos | 2 | 4644 / 15496 ms | 187 / 358 ms |

Findings that drive the remaining phases:

1. **The relay hop is real but not catastrophic**: ~2.9 s p50 / 6.2 s p95 from
   `sent` to `ack` on the escpos path. A 1.5 s agent poll interval was a large,
   removable share of it. Phase 4 stays in scope, as written.
2. **The PDF disposition is the actual outlier** — 64–67 s p50 to settle, and the
   majority of pdf jobs never settle at all (`sent` or `dead_letter`:
   `sales.invoice` pdf 27 rows stuck at `sent` p50 36 s, `sales.order_ack` and
   `sales.delivery_note` pdf rows in `dead_letter`). This is the drain path Phase 5
   migrates; it is now the highest-value remaining work after Phase 4.
3. **Enqueue-side cost is dominated by the legacy `pos_receipt` and
   `purchase_order` paths** (3.3 s and 4.6 s p50, 15+ s p95), which are exactly the
   surfaces that have not yet moved onto the collapsed non-blocking path.

## Pending

1. **Phase 4 item 4 — prove the win.** Re-run the table above once live traffic
   flows through the long-poll agent and the cached presence path, and compare
   `relay.preflight` / `relay.agent_roundtrip` percentiles before and after. Needs
   an agent build deployed to a workstation.
2. **Phase 5 — one shape for every document.** Invoices, delivery notes, POs, GRNs,
   warehouse and inventory documents move onto the collapsed enqueue → drain path
   with non-blocking acknowledgement. Only `PostPaymentSurface` uses
   `startPrintDocument` today; every other surface still blocks on `printDocument`.
   Labels keep the client-side render but adopt the same acknowledgement and spans.
   The measured PDF-drain stall (finding 2 above) is part of this phase and is the
   single largest remaining latency defect in the system.
3. **Phase 6 — guardrails.** Architecture test: no render or dispatch on the
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
2. **Then resume at the next milestone in order** — Phase 4 item 4 (before/after
   percentiles once the long-poll agent build is on a workstation), then Phase 5
   starting with the stalled PDF drain path, then Phase 6. Do not skip ahead to
   Phase 6 guardrails before the Phase 5 surfaces exist to guard.
3. Keep execution chronological; do not open unrelated work, leave partial features,
   or ship orphaned functionality. Bring each phase to a production-ready state.
4. Update this file immediately after each completed item.

## Technical notes

- The original roadmap's latency claims (labels 3–5 s, invoices 11–18 s, receipts
  ~21 s) are now partly measured — see the table above. Labels and the escpos paths
  are far faster than claimed; the pdf disposition is far *slower*. Re-measure from
  `print_traces` (finer stage granularity) once operator prints have run.
- Existing guards (`no-printservice-shim`, `no-raw-escpos-bytes`, hardware
  chokepoint, `no-direct-generate-document-in-pages`) must stay green.
