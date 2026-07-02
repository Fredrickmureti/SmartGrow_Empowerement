# Scanner Cockpit — Wave 8 close-out (2026-05-26)

## Re-audit verdict on Wave 7

| Claim | Verdict |
|---|---|
| `MobileScannerPage` imports `enqueueScan` / `drainQueue` from `@/services/scanner/replayQueue` and uses them instead of a duplicated inline implementation | Verified — `src/pages/pos/MobileScannerPage.tsx:46-50, 330, 476` |
| `src/test/architecture/scanner-ack-send-discipline.test.ts` fails the build if any file outside `useScanChannel` / `usePOSScannerChannel` broadcasts `ack` / `revoke` / `ping` | Verified — present, picked up by vitest |
| 75/75 green on `src/test/scanner` + the two architecture guards | Verified locally |

No regressions found, no shortcuts to clean up.

## Shipped this wave — closing the ADR-0013 "out of scope" residue

The previous agent left "Native Zebra DataWedge / Honeywell SwiftDecoder
SDKs" deferred. Wave 8 closes that residue with a thin, vendor-isolated
adapter layer that ends at the existing `broadcastScan` seam, so
telemetry / replayQueue / ackOutbox / cockpitMetrics / recent rail /
health pill / presence list all keep their contracts unchanged.

| Track | Files | Tests |
|---|---|---|
| Capability detection | `src/services/scanner/native/detectNativeScanner.ts` | `src/test/scanner/detect-native-scanner.test.ts` (7 cases) |
| Zebra adapter | `src/services/scanner/native/dataWedgeAdapter.ts` | `src/test/scanner/data-wedge-adapter.test.ts` (5 cases) |
| Honeywell adapter | `src/services/scanner/native/honeywellAdapter.ts` | `src/test/scanner/honeywell-adapter.test.ts` (3 cases) |
| Shared bus | `src/services/scanner/native/nativeScanBus.ts` | exercised via adapter suites |
| React seam | `src/hooks/scanner/useNativeScanner.ts` | exercised end-to-end via the page |
| Cockpit integration | `src/pages/pos/MobileScannerPage.tsx` — adds the hook, persists an operator toggle in `sessionStorage`, surfaces a "Zebra DataWedge" / "Honeywell scan engine" chip in the metrics row | n/a |
| Architecture guard | `src/test/architecture/native-scanner-seam.test.ts` | new guard |
| Operator docs | `docs/scanner/zebra-datawedge-profile.md`, `docs/scanner/honeywell-datacollection-profile.md` | n/a |

## What native SDK integration buys the operator

- Trigger-pull → feedback drops from ~300–800 ms (camera + ZXing) to
  ~30–80 ms (hardware scan engine).
- Works in poor light, with the screen off, and with a glove on.
- Battery lasts a full shift — camera + ML decode is the largest power
  draw in the current cockpit.
- Symbology + AIM identifier land on every scan, useful to spot when a
  wrong-format barcode was decoded as the wrong family.
- No keyboard-wedge race condition when focus changes.

## ADR-0013 amendment

"Native scanner SDKs (Zebra, Honeywell)" is no longer "Out of scope" —
status moves to Accepted, shipped 2026-05-26. iOS-side SwiftDecoder
camera-SDK integration remains out of scope (needs a native shell, not
a web seam).

## Residue (honest)

- Adapters assume the device profile is configured per the docs above;
  if it is not, the cockpit silently falls back to camera + keyboard
  wedge. Chip reads "detected but disabled" but we cannot verify the
  device-side profile programmatically.
- `symbology` is captured by the adapters and the bus but not yet
  rendered on the recent-rail row — small follow-up.
- `useNativeScanner` is exercised end-to-end through the page rather
  than in a dedicated hook unit test.

## Files touched

- created `src/services/scanner/native/detectNativeScanner.ts`
- created `src/services/scanner/native/dataWedgeAdapter.ts`
- created `src/services/scanner/native/honeywellAdapter.ts`
- created `src/services/scanner/native/nativeScanBus.ts`
- created `src/hooks/scanner/useNativeScanner.ts`
- created `src/test/scanner/detect-native-scanner.test.ts`
- created `src/test/scanner/data-wedge-adapter.test.ts`
- created `src/test/scanner/honeywell-adapter.test.ts`
- created `src/test/architecture/native-scanner-seam.test.ts`
- created `docs/scanner/zebra-datawedge-profile.md`
- created `docs/scanner/honeywell-datacollection-profile.md`
- edited `src/pages/pos/MobileScannerPage.tsx`
- edited `docs/adr/0013-scanner-as-erp-input-infrastructure.md`
- edited `.lovable/plan.md`
