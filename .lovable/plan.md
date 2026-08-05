# POS Printing Latency: Architecture Audit and Redesign

## What the code actually does today (verified by reading the pipeline)

Every print, regardless of document type, walks a strictly sequential chain of network round trips from the browser. Nothing overlaps, and each hop is awaited before the next begins.

For a POS receipt after payment (`PostPaymentSurface` → `printDocument`):

```text
resolvePrintPolicy            RPC round trip
print_job_insert              RPC round trip (once PER COPY)
resolveSourceDocumentRecordId RPC round trip (freeze pair -> record)
render-document               Edge Function (cold boot + full render + base64)
resolve_device                RPC round trip
workstations liveness         SELECT round trip
edge_jobs queue allowance     COUNT round trip
edge_jobs insert              INSERT round trip
agent claim                   up to 1.5 s poll interval (agent/src/relay.ts)
printer write                 TCP session, agent waits for socket close
result -> caller              Realtime UPDATE, else 1.5 s poll fallback
print_job_mark_sent           RPC round trip
print_job_mark_acked_by_id    RPC round trip
```

The reprint / intent path (`printDocumentIntent`, used by back-office and receipt reprint) adds even more on top: `ensure_document_record` RPC, then the `submit-document-intent` Edge Function (which itself boots, does a `document_records` lookup, runs `requireOrgMember`, then an RPC), then `loadJobs` SELECT, then `resolveOrganizationId` SELECT, then `claimForForeground` RPC per job — and only then enters the render + dispatch chain above.

Two structural facts explain the measured spread without any guesswork being needed about the printer:

1. **The latency is proportional to the number of serialized cloud hops, not to the bytes printed.** Labels (`printLabel`) render client-side from `label_templates` and skip `render-document` and the document-record machinery entirely — hence 3–5 s. Invoices add the Edge render of a full PDF — hence 11–18 s. Receipts add the document-record freeze, the intent Edge Function, job claim, and post-dispatch ledger writes — hence ~21 s.
2. **The UI is blocked for the whole chain.** The "Print dispatched" toast is emitted after `printDocument` resolves, which is after the printer has finished and the ledger has been closed. That is the ~5 s of dead UI. There is no dispatch acknowledgement distinct from completion anywhere in `PrintService`.

The relay is *not* the dominant cost (worst case ~3 s from the 1.5 s claim poll plus 1.5 s result poll fallback), but it is on the blocking path and it does two extra SELECTs (liveness, queue allowance) before it even enqueues.

## What enterprise POS platforms do differently

Square, Lightspeed, Oracle Retail, NCR and D365 Commerce all treat the receipt as a **consumer of a committed sale event**, not a step inside checkout. The cashier's UI is released at sale commit; the receipt is rendered and routed by a worker. Acknowledgement to the cashier means "the sale is durable and the receipt is queued", never "the printer finished". Bytes are rendered from a frozen snapshot at or before commit, so rendering is never on the interactive path.

Our architecture is the opposite: checkout awaits render, awaits device resolution, awaits the printer, awaits the audit ledger.

## Phase 1 — Measure before changing anything

Add a single tracing seam (`src/services/observability/trace.ts`) exposing `withSpan(name, fn)` plus a correlation-scoped collector. Instrument, with no behaviour change:

- `PrintService.printDocument` / `printDocumentIntent`: policy, job-open, record-resolve, render, per-copy dispatch, ledger-close.
- `render.ts`: Edge invoke wall time, byte size, base64 decode.
- `submitIntent`, `ensureDocumentRecord`, `jobs.ts` RPCs.
- `execForIntent` / `assignmentDispatch`: resolve, transport route, agent call.
- `RelayTransport`: liveness, queue allowance, insert, enqueue→claim, claim→result.
- `agent/src/relay.ts` and `agent/src/routes/print.ts`: claim→socket-open→socket-close.

Spans persist to a `print_traces` table keyed by `correlation_id` and surface in the existing hardware diagnostics screen as a waterfall. Deliverable: a real latency budget per document type, replacing the estimates above with measurements.

## Phase 2 — Unblock the cashier (event-driven receipt)

Restructure the POS post-payment path so the boundary is the sale commit, not the print:

- Sale commit publishes a receipt business event and returns. The cashier's UI is released here; target < 500 ms acknowledgement.
- `PostPaymentSurface` renders the frozen snapshot locally for the on-screen preview and shows a live print status pill fed by `print_jobs` Realtime — queued → sent → printed → failed.
- The print job is dispatched in the background by the existing foreground drainer, now non-blocking, with the sweeper unchanged as recovery.
- Toast semantics change to acknowledgement-on-enqueue, with a failure toast driven by the job row transitioning to `failed`.

## Phase 3 — Collapse the round trips

- Fold policy resolution, document-record materialization, intent submission and job enqueue into **one** RPC (`pos_enqueue_receipt_print`) called at commit. Removes 4–6 sequential round trips.
- Move receipt ESC/POS rendering to commit time (or into that same RPC's job payload) so `render-document` is off the interactive path. Reuse the frozen `pos_receipt_snapshots` payload — no new formatter.
- Batch ledger transitions: `sent` + `acked` become one RPC; open N copies in one RPC instead of N.
- Make ledger writes fire-and-forget relative to the print, as they already are error-wise.

## Phase 4 — Cut relay dead time

- Replace the agent's 1.5 s poll loop with a Realtime subscription on `edge_jobs` for its workstation, keeping the poll as a fallback heartbeat. Removes up to 1.5 s of claim latency.
- Drop the liveness SELECT and queue-allowance COUNT from the hot path; derive both from a cached workstation presence value refreshed by the heartbeat.
- Keep the per-endpoint FIFO queue in `agent/src/routes/print.ts` and the socket-close completion semantics — both are correct and must not be weakened.

## Phase 5 — Apply the same shape to invoices and labels

Once receipts are event-driven, invoices reuse the identical enqueue → worker → dispatch path; labels keep their client-side render but adopt the same non-blocking acknowledgement and the same tracing spans. One pipeline, one latency profile, one place to look when it is slow.

## Guardrails

- Architecture test forbidding a `print_jobs` render or dispatch on the checkout critical path.
- Architecture test asserting every stage in `PrintService` is wrapped in a span.
- Regression test asserting acknowledgement is emitted before dispatch completes.
- Existing guards (`no-printservice-shim`, `no-raw-escpos-bytes`, hardware chokepoint) stay green.

## Targets

| Stage | Target |
| --- | --- |
| Cashier acknowledgement after Confirm | < 500 ms |
| Receipt bytes leave the browser | < 1 s |
| Printer begins printing | < 1.5 s |
| Full cashier workflow | < 2 s |

## Note on scope

Phase 1 is measurement only and lands first, so Phases 2–5 are justified by numbers rather than by the reasoning above. If the traces contradict the reading — for example if the printer socket, not the cloud chain, dominates — the later phases get re-scoped before any of them is implemented.
