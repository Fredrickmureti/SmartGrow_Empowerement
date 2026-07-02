# Zebra DataWedge profile for the Lovable Scanner Cockpit

The `MobileScannerPage` (`/pos/scan`) auto-detects Zebra ruggedized
Android handhelds (TC22/TC27/TC52/MC93 …) and enables hardware-trigger
scanning when the device DataWedge profile delivers scans the way
the adapter expects.

Without this profile, the page still works in camera + keyboard-wedge
mode, but trigger-pull-to-feedback latency stays at ~300–800 ms instead
of the ~30–80 ms the scan engine is capable of.

## One-time deploy via StageNow / EMM

Create a DataWedge profile named **Lovable Scanner** and associate it
with the browser package running the PWA (typically `com.android.chrome`).

| Setting | Value |
|---|---|
| Profile enabled | ON |
| Associated apps | `com.android.chrome` (or your PWA host) |
| Barcode input | Enabled, all symbologies the operator needs |
| Keystroke output | OFF (avoid double delivery) |
| Intent output | ON |
| Intent action | `app.lovable.scanner.SCAN` |
| Intent delivery | Broadcast intent |
| JavaScript injection | ON (preferred — lowest latency) |

With JavaScript injection on, DataWedge calls `window.datawedge(json)`
inside the focused WebView. The adapter wraps that bridge and forwards
to the cockpit pipeline.

## Payload shape the adapter accepts

```json
{ "data": "5901234123457", "labelType": "LABEL-TYPE-EAN13" }
```

The adapter is forgiving: `labelType` is optional, and the detail may
also arrive as a JSON-encoded string (intent-shim variant).

## Verifying

1. Open `/pos/scan` on the handheld and pair as usual.
2. The cockpit metrics row shows a green "Zebra DataWedge" chip
   next to the latency reading. If the chip is grey and reads
   "Use device scanner", the profile is detected but the operator
   toggle is off — tap it.
3. Pull the hardware trigger. Scans should land within ~80 ms and the
   recent-scans rail shows the symbology when DataWedge supplies it.

## Troubleshooting

- Chip never appears → User-Agent does not contain a known Zebra
  model token. Confirm the device model via `chrome://version`.
- Chip is present but no scans land → Profile not associated with
  the browser app, or "Intent output" is off. Verify in DataWedge.
- Every trigger pull fires twice → Keystroke output is still on in
  addition to intent/JS output. Turn it off.
