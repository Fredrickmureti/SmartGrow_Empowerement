---
name: Scanner device modes (handheld vs companion)
description: One device can be both the ERP and the scanner. Handheld mode = local camera → scanBus in-process; companion mode = paired phone over Realtime. Never pair a device to itself.
type: feature
---

## The rule

A scan surface must work on the device the operator is actually holding.
Two modes, resolved by `scannerDeviceMode` (`auto | handheld | workstation`,
persisted per device, operator-overridable):

- **handheld** — the ERP runs on the scanning device. `<ScanCameraButton>`
  opens the single `<LocalScanOverlay>` viewfinder; the decode is emitted
  **in-process** on `scanBus` with `source: "camera"`. No `scanner_session`,
  no pairing token, no realtime hop.
- **workstation** — wedge gun or paired phone (ADR 0013 flow, unchanged).
  The camera affordance is hidden.

## Invariants

1. `services/scanner/camera/useCameraDecoder.ts` is the ONLY module that may
   call `getUserMedia`, touch `BarcodeDetector`, or import `@zxing/*`.
   Exemptions: `captureSelfie` (not barcodes) and `MobileScannerPage` (the
   companion cockpit's device-side pipeline, tracked for consolidation).
   Enforced by `src/test/architecture/scanner-single-camera-engine.test.ts`.
2. `<LocalScanOverlay>` is mounted exactly once, in `AuthenticatedShell`.
   `openLocalScan()` is called only from `useLocalScan`.
3. Handheld adds a **source**, never a pipeline. Downstream behaviour —
   250 ms cross-source dedupe, `scanRouter` precedence, `wasConsumed`,
   `scanFeedbackBus` source tagging, WMS intents, the identity gate — is
   identical to a gun scan.
4. The viewfinder steals DOM focus. Any focus-gated target (e.g.
   `<BarcodeInputField>`) MUST stay registered with `scanRouter` while the
   overlay is open, and `<ScanCameraButton>` preventDefaults `mousedown`.
   Otherwise the decode arrives with no target.
5. `/wm` screens opt in with `MobileWarehouseLayout`'s `scanLabel` /
   `scanContinuous` props — the decode routes to the screen's registered WMS
   intent, so no input needs focus first.
6. `ScannerPairingButton` is mode-aware: on a handheld the primary action is
   "Scan" (own camera); pairing a separate phone is secondary. Never present
   pairing as the only way to scan.

See ADR 0107 (`docs/adr/0107-scanner-device-modes.md`).
