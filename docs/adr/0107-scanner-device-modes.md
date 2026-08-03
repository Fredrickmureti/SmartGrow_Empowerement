# ADR 0107 — Scanner device modes: handheld vs companion

Status: Accepted (2026-08-03)

## Context

ADR 0013 made the scanner ERP-wide input infrastructure, but it only ever
modelled one topology: **a workstation driven by a second device**. The
operator opened a page on a PC, minted a `scanner_session`, scanned the QR
with a phone, and from then on the phone was a dumb gun broadcasting
`{ code, seq }` over `scan:session:<id>`.

That topology fails the most common warehouse reality: the operator is
holding *one* phone and wants to run the ERP on it. Opening
`/wm/receiving` on a phone gave them a scan field, a "Pair phone scanner"
button that would pair the phone to itself, and no camera. The only
options were typing barcodes by hand or finding a PC.

## Decision

A device has a **scanner device mode**:

- **`handheld`** — the ERP and the camera are on the same device. Scan
  surfaces render a camera affordance; tapping it opens one global
  viewfinder, the decode is emitted **in-process** on `scanBus` with
  `source: "camera"`, and `scanRouter` delivers it to the topmost active
  target. No session, no pairing token, no realtime hop, no second device.
- **`workstation`** — the scanner is a wedge gun or a paired phone. The
  camera affordance is hidden (it would be noise) and the existing
  companion pairing flow is unchanged.

Mode is resolved by `scannerDeviceMode`: a UA/pointer/`getUserMedia`
heuristic, overridable by an operator preference persisted per device
(`auto | handheld | workstation`). The pairing dialog leads with the fork
("Scan with this device" vs "Pair another phone"), so the operator is asked
once per device rather than once per screen.

### Primitives

| Module | Role |
| --- | --- |
| `services/scanner/camera/useCameraDecoder.ts` | THE decode engine: `BarcodeDetector` → `@zxing/browser` ladder, stream lifecycle, visibility pause, torch, repeat dedupe |
| `services/scanner/camera/deviceMode.ts` | Mode detection + persisted operator override |
| `services/scanner/camera/localScanService.ts` | Singleton seam: `openLocalScan()` → viewfinder → `scanBus.emit({ source: "camera" })` |
| `components/scanner/LocalScanOverlay.tsx` | The one viewfinder, mounted in `AuthenticatedShell` |
| `hooks/scanner/useLocalScan.ts` | Mode-aware hook for surfaces |
| `components/scanner/ScanCameraButton.tsx` | The affordance; renders only in handheld mode |

### Delivery is unchanged

The local path stops at `scanBus`. Everything downstream — the 250 ms
cross-source dedupe, `scanRouter` target precedence, `wasConsumed`,
`scanFeedbackBus` source tagging, WMS scan intents, the identity gate —
behaves exactly as it does for a wedge gun or a paired phone. Handheld mode
adds a *source*, not a pipeline.

## Consequences

- Any surface already using `<BarcodeInputField>`, `<BinScanField>`,
  `<ProductScanField>` or a WMS scan intent gains camera scanning for free.
- `/wm` screens expose a floating "Scan with camera" button via
  `MobileWarehouseLayout`'s `scanLabel` prop, so the decode lands on the
  screen's registered intent without focusing an input first.
- `ScannerPairingButton` becomes mode-aware: primary "Scan" on a handheld,
  with pairing demoted to a secondary icon.
- `ScanCameraButton` suppresses focus loss (`onMouseDown` preventDefault)
  and `<BarcodeInputField>` stays registered with `scanRouter` while the
  viewfinder is open — otherwise the field would deregister on blur and the
  decode would have nowhere to land.
- Guarded by `src/test/architecture/scanner-single-camera-engine.test.ts`:
  one camera engine, one viewfinder mount, `openLocalScan` only via the
  service seam.

## Out of scope / tracked

- `MobileScannerPage` (the companion cockpit) still owns its device-side
  pipeline (ROI crop, zoom ramp, Zebra/Honeywell SDK bridges) and is an
  explicit exemption in the guard. Consolidating it onto `useCameraDecoder`
  is a later pass.
- Continuous "hands-free" scanning is opt-in per surface (`scanContinuous`),
  not a global mode.
