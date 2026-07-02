# Scanner Cockpit — Wave 4 (2026-05-22)

## Re-audit verdict on waves 1-3

All wave-2/3 claims verified against the working tree. 50/50 prior tests
green before wave-4 changes. No regressions found.

## Shipped in wave 4

| Track | Surface | Files | Tests |
|---|---|---|---|
| 1 — Desk ACK outbox | Pure FIFO ring buffer (cap 100, dedupe, drop-oldest, one-shot full notice). Wired into both desk hooks: ACKs sent while `channelReady` is false are enqueued and drained on next `SUBSCRIBED`. Verdicts can no longer be silently lost across a transient desk-side reconnect. | `src/services/scanner/ackOutbox.ts`, `src/hooks/pos/useScanChannel.ts`, `src/hooks/pos/usePOSScannerChannel.ts` | `src/test/scanner/ack-outbox.test.ts` (4 tests) |
| 2 — Phone cockpit metrics + manual reconnect | Uptime (mm:ss), scans/min (rolling 60 s), median ACK latency (rolling 20 samples) rendered in a new metrics row under the status band. Pure helpers; 1 Hz tick for re-render. Operator-visible **Reconnect now** chip appears whenever health ≠ ok (with retry-in-Ns countdown while channel is reconnecting). | `src/services/scanner/cockpitMetrics.ts`, `src/pages/pos/MobileScannerPage.tsx` | `src/test/scanner/cockpit-metrics.test.ts` (8 tests) |
| 3 — Recent rail filters + rescan | All / Errors / Unknown chips above recent list (client-only). Each non-pending row gets a **Rescan** action that re-emits the code through `broadcastScan` with a fresh seq. | `src/pages/pos/MobileScannerPage.tsx` | covered by interaction; pure parts unit-tested above |

## Honest residue (deferred for a follow-up wave)

- **Desk telemetry viewer route** (`/pos/scanner-telemetry`) reading `scan_events` — RPC + server fn + UI table. Wave-2 telemetry is still write-only.
- **Multi-phone presence rows on the desk pairing dialog** with active-source highlight + inline rename (`pos_rename_scanner_device` RPC). Presence is collected but rendered as a count.
- **AI auto-naming suggestion** from `register_name + device_label + most-frequent workflow`. No new external dependency required; deferred only because it depends on the rename RPC above.
- **Keyboard shortcuts overlay parity on the phone** (`?` overlay). The desk has it; the phone does not yet.
- **Architecture guard test forbidding raw `channel.send(...ack...)` outside the two hook files** — should be added before merge.

## Verification

- `bunx vitest run src/test/scanner src/test/architecture/scan-event-sampling` → **62/62 green** (50 prior + 12 new across `ack-outbox` and `cockpit-metrics`).
- ACK outbox invariant: `channelReady === false ⇒ enqueueAck(...)`, drained FIFO on next `SUBSCRIBED`. Locked by inline JSDoc + unit tests.
- `lastScanAt` pong-only-exclusion invariant retained (wave-3 comments untouched).

## Files touched in this wave

- created `src/services/scanner/ackOutbox.ts`
- created `src/services/scanner/cockpitMetrics.ts`
- created `src/test/scanner/ack-outbox.test.ts`
- created `src/test/scanner/cockpit-metrics.test.ts`
- edited `src/hooks/pos/useScanChannel.ts`
- edited `src/hooks/pos/usePOSScannerChannel.ts`
- edited `src/pages/pos/MobileScannerPage.tsx`