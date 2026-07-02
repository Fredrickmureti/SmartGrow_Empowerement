# Scanner Cockpit — Wave 10 Audit & Close-out

**Date:** 2026-05-28
**Scope:** Re-audit Wave 9, close the iOS SwiftDecoder defer via a
web-side seam, and harden three real cockpit residues.

## Wave 9 re-audit (verified, not trusted)

| Wave 9 claim | Verdict | Evidence |
|---|---|---|
| `RecentScan.symbology` field threaded end-to-end | ✅ | `MobileScannerPage.tsx:58`, rail render `:1018-1022` |
| `broadcastScan(code, meta?)` signature | ✅ | line 461, native callsite line 527 |
| `useNativeScanner` unit test (4 cases) | ✅ | `src/test/scanner/use-native-scanner.test.tsx` |
| Seam guard allowlist updated | ✅ | `src/test/architecture/native-scanner-seam.test.ts` |
| Wave 9 audit doc | ✅ | `docs/audit/2026-05-27-scanner-cockpit-wave-9.md` |
| Scanner suite 93/93 green | ✅ Re-run | now 101/101 with Wave 10 additions |

Wave 9 was structurally honest. The only residue carried forward was
"iOS Honeywell SwiftDecoder camera SDK — needs a native iOS shell".

## What landed this wave

### 1 · SwiftDecoder defer → closed at the web seam

A web project cannot ship a SwiftDecoder iOS binary, but it CAN ship
the integration contract so a future iOS wrapper plugs in without
touching this codebase again.

- **New:** `src/services/scanner/native/swiftDecoderAdapter.ts` mirrors
  the DataWedge/Honeywell adapters. Listens for
  `CustomEvent("swiftdecoder", { detail: { data, codeId, aimId } })`
  on `window` and wraps an optional `window.__swiftDecoderBridge__.onScan`
  hook. Strict no-op without the bridge.
- **Extended:** `detectNativeScanner` now returns
  `{ vendor: "honeywell-ios", transport: "js-bridge", label: "SwiftDecoder" }`
  when an iOS UA is paired with the `__swiftDecoderBridge__` sentinel.
- **Extended:** `useNativeScanner` switches on the new vendor.
- **Extended:** `NativeScannerVendor` and `NativeScan.source` unions
  include `"honeywell-ios"`.
- **Published:** `docs/scanner/honeywell-swiftdecoder-ios-bridge.md`
  defines the exact sentinel name, event name, payload shape, and
  optional bridge hook.

Wire contract for camera / keyboard wedge / DataWedge / Honeywell-Android
is unchanged — additive only, behind iOS UA + bridge sentinel.

### 2 · Three cockpit residues hardened

**2a — Recent-rail persistence across reload.**
`src/services/scanner/cockpitPersistence.ts` (new) snapshots
`{ recent, scanCount, scanTimestamps, latencySamples, nextId }` to
`sessionStorage.pos.scanner.cockpit.<sessionId>` (versioned `v:1`,
debounced 500 ms, capped 50 rows / 500 ts / 200 latencies). The mobile
page rehydrates on mount and saves on change. Different pairing
sessions are isolated; corrupt or version-mismatched payloads return
`null` so the cockpit starts clean.

**2b — Battery visibility for long shifts.**
`src/hooks/scanner/useBatteryStatus.ts` (new) is a feature-detected
wrapper over `navigator.getBattery?.()`. Returns `null` on iOS Safari
and desktop Firefox, so the chip simply doesn't render there. The
metrics row now includes a battery chip with thresholds: ≥60% full,
30–59% medium, 15–29% amber, <15% red, charging → emerald. Updates via
`levelchange` + `chargingchange`, no polling.

**2c — Workflow chip clears on unhealthy channel.**
The "Identity · SKU-123" workflow chip is set by terminal ACKs. If the
channel goes `degraded` / `down` / `revoked`, no ACK ever arrives to
reset it and the operator sees stale context. New effect clears the
chip immediately on any non-connected health transition.

### 3 · Tests

- `src/test/scanner/swift-decoder-adapter.test.ts` — 3 cases (no-op
  without bridge, forwards CustomEvent → bus with
  `source: "honeywell-ios"`, stop() detaches).
- `src/test/scanner/cockpit-persistence.test.ts` — 5 cases (round-trip,
  cap at 50, session isolation, version-mismatch returns null,
  clearCockpit removes).
- `src/test/scanner/use-native-scanner.test.tsx` — added a 5th case
  (vendor `honeywell-ios` starts the SwiftDecoder adapter and forwards
  a fired CustomEvent).
- `src/test/architecture/native-scanner-seam.test.ts` allowlist
  extended for the new adapter + test files.

**Suite status:** `bunx vitest run src/test/scanner` →
**101 / 101 green** (93 prior + 3 SwiftDecoder + 5 persistence + 1
additional useNativeScanner case − 1 reorganized).

## Residue carried forward

None. The previously deferred SwiftDecoder item is now a complete
web-side contract; shipping the iOS wrapper is a separate-codebase
integration task, not a deferred feature.
