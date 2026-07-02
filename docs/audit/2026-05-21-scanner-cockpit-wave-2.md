# Scanner cockpit — wave 2 + wave 3 status

Date: 2026-05-22

## What shipped (wave 2)

- `scan_events` audit table + `scan_events_rate` rate-limit table + `log_scan_event(jsonb)` SECURITY DEFINER RPC + nightly `purge_scan_events` pg_cron — migration `20260520023849_*`.
- Desk-side telemetry sender wired in `src/hooks/pos/useScanChannel.ts` and `src/hooks/pos/usePOSScannerChannel.ts` (fire-and-forget; enriched with per-code `{ deviceId, seq, decodedAt }` so `latency_ms` reflects the phone stamp).
- Phone-side replay buffer in `src/pages/pos/MobileScannerPage.tsx` — `pendingScansRef`, cap 50, drop-oldest, FIFO drain on SUBSCRIBED.
- Workflow chip auto-clears after 30 s.

## What shipped (wave 3 — this turn)

| Item | File | Notes |
|---|---|---|
| Visible offline-queue pill | `src/pages/pos/MobileScannerPage.tsx` (status band) | Renders only when `queueDepth > 0`; warning tone; auto-hides on drain. |
| Recent-list **Clear** button | `src/pages/pos/MobileScannerPage.tsx` (recent rail) | Ghost button, no confirmation; hidden when empty. |
| `lastScanAt` pong invariant | `src/hooks/pos/useScanChannel.ts`, `src/hooks/pos/usePOSScannerChannel.ts` | Re-verified: pong handler updates RTT only. Locked with an in-source INVARIANT comment to stop future regressions. |
| RLS catalog regression | `supabase/tests/scanner_session_rls_test.sql` | Asserts RLS on, RESTRICTIVE no-direct-write present, SELECT scoped to `auth.uid()`/`user_roles`, required SECURITY DEFINER RPCs exist, `anon` has no SELECT. |
| Replay-buffer unit tests | `src/services/scanner/replayQueue.ts` (extracted helper) + `src/test/scanner/replay-buffer.test.ts` | FIFO, cap-50 drop-oldest, one-shot full toast latch, double-drain is a no-op. |
| Scan-event sender unit tests | `src/services/scanner/scanEventTelemetry.ts` (extracted helper) + `src/test/scanner/scan-event-sender.test.ts` | Payload wire-shape locked; RPC rejection / error envelope swallowed. |
| Architecture guard | `src/test/architecture/scan-event-sampling.test.ts` | Fails the build if any source file does `from("scan_events").insert(...)` directly. |

Both desk hooks now import `sendScanEvent` from the shared helper, eliminating the duplicated RPC call sites.

## Verification

- `bunx vitest run src/test/scanner src/test/architecture/scan-event-sampling`: green, 4 existing scanner suites + 2 new + 1 architecture guard.
- Manual: phone status band shows the `queue N` chip while offline; chip disappears on reconnect drain; Clear empties the recent rail.

## Still deferred (out of scope)

- Desk-side ring-buffer replay — covered today by per-`(device_id, seq)` dedupe; full ring would only matter for multi-second outages where presence already drops the device.
- Multi-scanner presence avatars in the `ScannerSessionDialog` — presence is tracked but not rendered.
- `scan_events` analytics page — waits for a week of real data.
- Native scanner SDKs (Zebra DataWedge intent receiver, Honeywell SwiftDecoder) — tracked in ADR 0013.
- AI auto-naming, terminal cart UI changes.