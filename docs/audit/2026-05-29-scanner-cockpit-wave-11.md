# Scanner Cockpit — Wave 11 (2026-05-29)

## Re-audit of prior agent claims

Wave 1–10 invariants verified untouched. Both reported issues
reproduced against the working tree before this wave:

1. `MobileScannerPage.subscribeOnce` (then at lines 285–406) flipped the
   pill to `reconnecting` on every `CHANNEL_ERROR | CLOSED | TIMED_OUT`,
   even when the next `SUBSCRIBED` (or an inbound ACK / ping) landed
   within a frame. ACKs continued to arrive while the operator saw a
   "reconnecting" pill — the exact symptom the user reported.
2. `handleRepair` (then line 783) posted a `BroadcastChannel` "reopen"
   to the desk and then `window.location.reload()`. The reload re-hit
   the already-consumed pairing token URL → "Pairing failed" → user
   had to close the tab and re-scan the new QR with the OS camera.
   No in-app re-pair path existed.

## Shipped this wave

| # | Surface | Files |
|---|---|---|
| 1 | `promoteOnInbound` + `DOWN_FLIP_DELAY_MS` (1500 ms) — pure helpers for the channel-state truth rules | `src/services/scanner/channelStateTruth.ts` |
| 2 | `noteInboundTraffic()` inside the subscribe closure: every ACK and ping clears any armed down-flip timer and promotes `connecting`/`reconnecting` → `connected`. `revoked` stays terminal | `src/pages/pos/MobileScannerPage.tsx` |
| 3 | `CHANNEL_ERROR/CLOSED/TIMED_OUT` no longer flips the pill immediately. It arms a 1500 ms timer that surfaces `reconnecting` only if neither `SUBSCRIBED` nor inbound traffic wins the race. The auto-resubscribe ladder is unchanged | `src/pages/pos/MobileScannerPage.tsx` |
| 4 | Subscribe-effect cleanup also clears `downFlipTimerRef`, so a tab close mid-debounce can't leak a setState into an unmounted tree | `src/pages/pos/MobileScannerPage.tsx` |
| 5 | New `parsePairingUrl` accepts path form (`/pos/scan/<token>`), legacy fragment form (`/pos/scan#<token>`), and bare tokens — covers both QR formats the desk generates plus manual paste recovery | `src/services/scanner/parsePairingUrl.ts` |
| 6 | New `useQrRepairScan` — minimal `BarcodeDetector` → ZXing camera scanner restricted to `qr_code`. Stops itself on first valid pairing-URL hit | `src/hooks/scanner/useQrRepairScan.ts` |
| 7 | Disconnected overlay rebuilt: "Scan new QR" launches the in-app rescan (camera preview + reticule + cancel); on token detect, `navigate('/pos/scan/<token>', { replace: true })` re-runs the existing claim effect — no tab close, no reload. Also exposes "Retry current pairing" as a soft option | `src/pages/pos/MobileScannerPage.tsx` |
| 8 | Overlay also triggers when `health === "down"` and `lastContactAgo > 30 s` (navigator online), so prolonged silent drops surface the same recovery path — not just explicit revokes | `src/pages/pos/MobileScannerPage.tsx` |
| 9 | Unit tests for both pure helpers | `src/test/scanner/channel-state-truth.test.ts`, `src/test/scanner/qr-repair-parse.test.ts` |

## What was kept and verified

- Wave 1–10 invariants: ack-outbox, replay queue, cockpit metrics,
  health derivation, scan-event sampling guard, `lastScanAt`
  pong-only-exclusion, native-scanner seam guard, `lastScanByDevice`
  fan-out — all untouched. Existing scanner test suite green
  (114/114 with the new tests added).
- The desk-side BroadcastChannel "reopen" path in
  `ScannerWorkspaceContext` is unchanged; the phone still nudges it
  before opening the in-app rescan, so the operator finds a fresh QR
  waiting on the terminal.
- Pill text is rendered from `useScannerHealth().health` via
  `healthMeta[health].label` (was already the case — confirmed during
  re-audit, no code change needed for plan item #3).

## Verification

- `bunx vitest run src/test/scanner` → **114 / 114 green** (101 prior +
  13 new across `channel-state-truth` and `qr-repair-parse`).
- Manual repro of the phantom-reconnecting flap: forced a Realtime
  `CLOSED` via tab backgrounding for <1 s — pill stays green, ACK
  band continues firing. Forced a 5 s offline → pill correctly
  surfaces `Reconnecting` after the debounce.
- Manual repro of in-app re-pair: revoked from the desk → phone shows
  the new overlay → tap "Scan new QR" → camera opens in QR mode →
  pointing at the freshly minted desk QR navigates in-page and the
  cockpit re-arms within ~1 s. Tab was never closed.

## Honest residue

- A dedicated jsdom test for `useQrRepairScan` (mocking
  `BarcodeDetector` and `getUserMedia`) is not included — the engine
  ladder is already exercised end-to-end by the existing native /
  ZXing surfaces, and the URL parser (the only piece that can decide
  wrong) has its own unit tests.
- The "retry current pairing" soft button in the new overlay reuses
  `handleManualReconnect`, which still respects the wave-4
  2-second-debounce rate-limit. No change.
