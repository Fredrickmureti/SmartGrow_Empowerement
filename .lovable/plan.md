# Scanner Device Modes — handheld (scan while working) vs companion (phone as input only)

## The problem, stated precisely

Today the phone can only be a *dumb input device*. `ScannerWorkspaceContext` mints a
`scanner_session`, the phone opens `/scan/<token>` (`MobileScannerPage`), decodes locally and
**broadcasts** the code over Supabase Realtime to another browser tab. Every scan-aware surface
(`BarcodeInputField`, `BinScanField`, `ProductScanField`, `useWmsScanIntent`) is a *receiver* of
that broadcast or of a USB wedge.

There is no code path where the camera of the **same device that is running the ERP** feeds a
field in the **same tab**. The only in-app camera (`InAppQrScanner` / `useQrRepairScan`) decodes
QR pairing URLs and navigates away.

Consequence, exactly as observed: an operator who opens Receiving on a phone has to either type
codes by hand, or find a PC and pair the phone to it. The phone can be a scanner or a workstation,
never both.

## How the industry solves it

Every serious WMS/POS treats "what is decoding" and "what is consuming" as two independent axes:

- **Zebra/Honeywell rugged terminals** — the browser app is the workstation; DataWedge injects the
  decode into the focused field of that same app (keyboard intent). One device, both roles.
- **Shopify POS / Square / Odoo Inventory mobile** — a camera button sits *on the field*. Tap,
  viewfinder opens, decode lands in the field, beep, viewfinder stays open in "continuous" mode
  for receiving/counting.
- **SAP EWM / Manhattan RF** — desktop console + tethered gun (our companion mode) *and* handheld
  RF terminals run the same task screens. Same screens, different input transport.

The correct abstraction is therefore not "a new phone app" but **a third scan source on the
existing kernel**: local camera → `scanBus.emit({ source: "camera" })` → `scanRouter` → whichever
target is active. Nothing downstream changes.

## Target model — three device modes

| Mode | Who runs the ERP | Who decodes | Transport |
| --- | --- | --- | --- |
| `handheld` (new) | the phone/tablet itself | its own camera (or built-in SDK on Zebra/Honeywell) | in-process, no network |
| `companion` (today) | a PC | a paired phone | Realtime `scan:session:<id>` |
| `wedge` (today) | any device | USB/Bluetooth gun | keyboard kernel |

Modes are not exclusive: a phone in `handheld` mode may still be paired as a companion, and a PC
in `wedge` mode may still accept a paired phone. Mode only decides **whether the local camera
button is offered**.

Default is auto-detected per device: `handheld` when the device has a camera and a coarse pointer,
`companion`/`wedge` otherwise. The operator can override it, and the override persists per device.

## What gets built

### 1. A device-local decode engine (`src/services/scanner/camera/`)

Extract the engine ladder currently duplicated in `MobileScannerPage` and `useQrRepairScan`
(native `BarcodeDetector` → ZXing dynamic import) into one `useCameraDecoder({ formats, onDecode })`
hook: torch control, `visibilitychange` pause, per-device dedupe window, camera teardown.
`useQrRepairScan` becomes a thin `formats: ["qr_code"]` caller so there is exactly one camera
engine in the repo.

### 2. One global scan overlay, one entry point (`LocalScanOverlay` + `localScanService`)

Mounted once in `AuthenticatedShell`. Any surface calls
`openLocalScan({ label, workflow, continuous })`. On decode it:

1. plays the `ok` tone from `feedbackTones` (loud beep + vibrate on failure — already built),
2. emits onto `scanBus` with `source: "camera"` and **no `sourceTopic`**, so Scoped-mode tenants
   accept it exactly like a wedge scan,
3. lets `scanRouter` deliver it to the topmost active target — the field that opened the overlay,
4. in `continuous` mode stays open with a running tally ("3 scanned — SKU-101 ×2"); in single-shot
   mode closes on the first accepted decode.

No surface ever touches `getUserMedia` directly.

### 3. Camera affordance on the existing scan fields

`BarcodeInputField`, `BinScanField` and `ProductScanField` gain a camera button (rendered only in
`handheld` mode) that focuses the field, registers it with the router, then opens the overlay. Zero
changes required at their ~40 call sites — Receiving, Put-away, Pick, Pack, Count, Returns,
Products, LPN screens all become phone-operable at once.

For task screens that have no visible input (`/wm` mobile put-away, pick, count), a floating scan
button in `MobileWarehouseLayout` triggers the currently registered WMS intent.

### 4. Mode surfacing, so the operator is never confused

- `ScannerWorkspaceContext` owns `deviceMode`, exposes it, persists the override.
- The existing scanner status chip reads "Camera (this device)" / "Phone paired" / "Gun".
- `ScannerSessionDialog` gains a first step: *Use this device's camera* vs *Pair another phone* —
  the choice the current UI never offered.
- In `handheld` mode we do **not** auto-mint a companion `scanner_session` (today it is minted on
  first read; on a phone that is pure waste).

### 5. Guards and docs

- `src/test/architecture/scanner-single-camera-engine.test.ts` — no `getUserMedia` /
  `BarcodeDetector` / `@zxing/*` import outside `src/services/scanner/camera/`.
- `src/test/architecture/scanner-local-scan-entry.test.ts` — camera scans reach the app only via
  `localScanService`; no component emits `source: "camera"` itself.
- `src/test/scanner/localScan.test.ts` — decode → beep → `scanBus` → focused target; continuous
  mode dedupe; overlay never emits when no target is registered.
- ADR `docs/adr/0107-scanner-device-modes.md` + update `mem://features/pos-phone-scanner.md`
  invariants (the phone-never-writes rule stays true for *companion* mode only; handheld mode is
  the ERP itself and is bound by the normal RLS/RPC rules).

## Explicitly out of scope

- No change to the companion pairing protocol, RLS, or `pos:scan:*` / `scan:session:*` topics.
- No native app / Capacitor work; handheld mode is the existing PWA using its own camera.
- No AI/auto-guessing of what a code means — resolution still goes through
  `useWmsIdentityGate` / `resolve_location_identity`.

## Sequencing

1. Camera engine extraction + `useQrRepairScan` refactor (no behaviour change).
2. `localScanService` + overlay + mode detection in `ScannerWorkspaceContext`.
3. Field-level camera buttons + `/wm` floating scan button.
4. Pairing dialog mode picker + status chip copy.
5. Guards, tests, ADR, memory update.
