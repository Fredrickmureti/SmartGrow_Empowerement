# Honeywell DataCollection profile for the Lovable Scanner Cockpit

Equivalent of the Zebra DataWedge guide, for Honeywell ruggedized
Android handhelds (CT45 / CT47 / CK65 / EDA52 …).

## One-time deploy via EZConfig / Honeywell EMM

Create a DataCollection profile and associate it with the browser
package running the PWA.

| Setting | Value |
|---|---|
| Default Intent | Enabled |
| Intent action | `com.honeywell.scanner.SCAN` |
| Intent delivery | Broadcast |
| Intent target package | `com.android.chrome` (or your PWA host) |
| Wedge / keystroke | Disabled |
| Web shim (HoneywellScanner) | Enabled if available |

The included Honeywell PWA shim dispatches
`CustomEvent('honeywellscan', { detail: { data, codeId, aimId } })`
on `window`. If the shim is not installed, the SwiftDecoder native
layer should be configured to deliver the same event via the EZConfig
web-data redirect.

## Payload shape the adapter accepts

```json
{ "data": "0123456789012", "codeId": "j", "aimId": "]E0" }
```

## Verifying

1. Open `/pos/scan` and pair as usual.
2. The cockpit metrics row shows a green "Honeywell scan engine"
   chip. If grey, the operator toggle is off — tap it.
3. Pull the trigger. Latency ≤ 100 ms; recent-scans rail shows the
   `codeId` symbology.

## Troubleshooting

- See the Zebra guide — the failure modes are identical in spirit
  (UA detection, profile association, double-delivery).
