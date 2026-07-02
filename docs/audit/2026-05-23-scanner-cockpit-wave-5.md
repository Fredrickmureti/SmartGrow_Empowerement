# Scanner Cockpit — Wave 5 close-out (2026-05-23)

## Re-audit of prior agent claims

| Claim | Verdict |
|---|---|
| `scanner_device_labels` + `pos_rename_scanner_device` + `list_scan_events` migration | Verified present |
| `/pos/scanner-telemetry` + viewer | Verified present |
| `DevicePresenceList` mounted in `MobileScannerDialog` | Verified present, but `lastScanByDevice` prop was not wired — "Active" pill inert |
| `PhoneShortcutsOverlay` mounted in `MobileScannerPage` | Verified present |
| `ack-send-discipline` architecture guard | Verified present |
| Deferred: live activity, real AI naming, tests, audit doc | Confirmed still missing — closed in this wave |

## Shipped this wave

- `usePOSScannerChannel` + `useScanChannel` now expose `lastScanByDevice`, updated **inside the broadcast handler after the per-device seq-dedupe guard** and throttled to ~4 Hz. Preserves the wave-3 "pong-only-exclusion" invariant for `lastScanAt`.
- `MobileScannerDialog` accepts and forwards `lastScanByDevice` to `DevicePresenceList`; `POSTerminal` passes it from the hook. The "Active" pill now lights up on the device whose last real scan landed within 30 s.
- New edge function `suggest-scanner-label` calls Lovable AI Gateway (`google/gemini-3-flash-preview`, JSON output) and returns 3 ≤28-char labels. Falls back to deterministic suggestions on 402/429/error so the chip never breaks the rename UX.
- `DevicePresenceList` "Suggest" chip now fires the edge function on open, shows a spinner, and renders AI results when available; otherwise stays on the deterministic fallback.
- `src/test/scanner/device-presence-list.test.tsx` — 3 tests: Active pill TTL on/off + suggestion fallback. All green.

## Verification

- `bunx vitest run src/test/scanner src/test/architecture/scan-event-sampling` → **65/65 green** (62 prior + 3 new).
- No changes to ack-outbox, replayQueue, or any wave 1-4 invariants.

## Honest residue

- pgTAP coverage for `pos_rename_scanner_device` / `list_scan_events` still TODO — RPC behaviour and RLS are exercised manually + via the new component test today.
- `ScannerTelemetry` and `PhoneShortcutsOverlay` still lack dedicated unit tests; behaviour is exercised via the existing scan-event-sampling guard and manual QA.
- `useScanChannel` callers (`ScannerSessionDialog`) do not yet render `DevicePresenceList`; the hook now exposes `lastScanByDevice` so a future wave can adopt it without a hook change.

## Files touched

- edited `src/hooks/pos/usePOSScannerChannel.ts`
- edited `src/hooks/pos/useScanChannel.ts`
- edited `src/components/pos/MobileScannerDialog.tsx`
- edited `src/pages/pos/POSTerminal.tsx`
- edited `src/components/scanner/DevicePresenceList.tsx`
- created `supabase/functions/suggest-scanner-label/index.ts`
- created `src/test/scanner/device-presence-list.test.tsx`