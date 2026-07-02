# Scanner Cockpit — Wave 9 Audit & Close-out

**Date:** 2026-05-27
**Scope:** Independently re-audit Wave 8, then close its honest residue
(symbology on the recent rail; dedicated `useNativeScanner` test).

## Re-audit of Wave 8 (verified, not trusted)

| Claim | Verdict | Evidence |
|---|---|---|
| `detectNativeScanner`, `dataWedgeAdapter`, `honeywellAdapter`, `nativeScanBus` shipped | ✅ True | files present in `src/services/scanner/native/` |
| `useNativeScanner` hook shipped | ✅ True | `src/hooks/scanner/useNativeScanner.ts` |
| `MobileScannerPage` mounts the hook with sessionStorage-backed operator toggle | ✅ True | `MobileScannerPage.tsx:510–530` |
| Native scans flow through the same seam as camera / keyboard wedge | ✅ True | `onScan → broadcastScan` at `MobileScannerPage.tsx:526` |
| Cockpit chip surfaces vendor + active state | ✅ True | `MobileScannerPage.tsx:820–835` |
| Seam architecture guard exists and runs | ✅ True | `src/test/architecture/native-scanner-seam.test.ts` |
| Vendor profile docs published | ✅ True | `docs/scanner/{zebra-datawedge,honeywell-datacollection}-profile.md` |
| ADR-0013 amended to drop "out of scope" for native SDKs | ✅ True | ADR text moved |
| **Symbology rendered on recent-rail row** | ❌ **FALSE before this wave** | `broadcastScan(code: string)` accepted only a string; `RecentScan` had no `symbology` field; row at line 1016 only rendered `detail \|\| code` |
| Dedicated `useNativeScanner` unit test | ❌ **Missing before this wave** | not present under `src/test/scanner/` |

Wave 8's structural work is solid. The two gaps were honestly disclosed
by the prior agent as residue; Wave 9 closes both.

## What landed this wave

### 1 · Symbology end-to-end onto the recent rail

- `RecentScan` (in `src/pages/pos/MobileScannerPage.tsx`) gained
  `symbology?: string | null`.
- `broadcastScan` signature extended:
  `broadcastScan(code: string, meta?: { symbology?: string | null })`.
  All existing callers (camera / ZXing / manual / rescan) keep working
  unchanged — `meta` defaults to undefined.
- `useNativeScanner.onScan` now forwards
  `broadcastScan(scan.code, { symbology: scan.symbology })`.
- New pending recent-rail entry stores symbology; ACK updates preserve
  it via the existing spread `{ ...next[idx], ... }`.
- Recent-rail row renders symbology as a small uppercase chip preceding
  the code, e.g. `EAN-13 · 5901234123457`. Falls back to the previous
  rendering when symbology is absent — zero visual change for camera /
  keyboard-wedge rows.

**Wire contract is unchanged.** The realtime payload, replay queue,
telemetry, ackOutbox, RLS, RPCs, and cockpit metrics are untouched.
Symbology lives only in local UI state.

### 2 · `useNativeScanner` unit test

`src/test/scanner/use-native-scanner.test.tsx` (jsdom + RTL, 4
assertions):

1. No-op when `detectNativeScanner` returns `vendor: null`.
2. Starts the Zebra adapter and forwards a fired `datawedge`
   `CustomEvent` to `onScan` with the normalised shape; unmount detaches.
3. Operator toggle `enabled: false` keeps the adapter detached even on a
   Zebra device.
4. `visibilitychange → hidden` pauses; `→ visible` resumes.

### 3 · Seam guard allowlist updated

`src/test/architecture/native-scanner-seam.test.ts` adds the new test
file to the legitimate-consumer allowlist so the seam stays single-purpose.

## Suite status

`bunx vitest run src/test/scanner src/test/architecture/native-scanner-seam.test.ts`
→ **93 / 93 green** (89 prior scanner + seam + 4 new). The unrelated
architecture failures in the broader repo (purchases branch stamping,
currency fallback, etc.) pre-date this wave and are out of scope.

## Residue carried forward

- iOS Honeywell SwiftDecoder camera SDK — still deferred. Requires a
  native iOS shell, not a web seam. Correctly listed under ADR-0013
  "future native targets".

No other Wave 8 / Wave 9 residue remains.
