# Hardware Capability Matrix

Operator reference. For each device class, the matrix shows which runtime
host can drive it, the concrete driver/transport in this codebase, and any
deployment caveats.

Legend: ✅ supported · ⚠️ partial · ❌ not supported.

| Device class            | Browser (Chrome / Edge)                                                 | Electron desktop                                                | LAN agent (planned)                                  | Driver / transport                                                                                                                                       |
|-------------------------|--------------------------------------------------------------------------|-----------------------------------------------------------------|------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| Keyboard-wedge scanner  | ✅ (no permission prompt)                                                | ✅                                                              | n/a                                                  | `drivers/KeyboardScannerDriver.ts`                                                                                                                       |
| USB HID barcode scanner | ✅ via WebHID (user gesture + per-device grant)                          | ✅ (native HID)                                                  | n/a                                                  | `drivers/HidScannerDriver.ts` + `transport/WebUSBTransport.ts`                                                                                           |
| Bluetooth scanner       | ⚠️ via Web Bluetooth (Chrome only; per-pair)                            | ✅                                                              | n/a                                                  | `drivers/HidScannerDriver.ts` (BT HID profile)                                                                                                           |
| Camera scanner          | ✅                                                                       | ✅                                                              | n/a                                                  | `BrowserHardwareAdapter.ts` camera path                                                                                                                  |
| ESC/POS thermal printer (USB) | ⚠️ via WebUSB (limited vendor support; printer must expose printer interface) | ✅ (native USB)                                                  | ✅                                                   | `drivers/EscPosPrinterDriver.ts` + `escpos-commands.ts` + `transport/WebUSBTransport.ts`                                                                |
| ESC/POS network printer | ❌ (no raw TCP in browser)                                              | ✅                                                              | ✅                                                   | `drivers/EposPrinterDriver.ts` (vendor SDK / raw 9100) — Electron-only transport                                                                         |
| Browser print (PDF / A4) | ✅                                                                       | ✅                                                              | n/a                                                  | `drivers/BrowserPrintDriver.ts`                                                                                                                          |
| Zebra / TSC label printer (USB) | ⚠️ via WebUSB                                                      | ✅                                                              | ✅                                                   | `drivers/EscPosPrinterDriver.ts` (ZPL/TSPL byte streams) — see `services/printing/labelDispatch.ts`                                                      |
| Zebra / TSC label printer (network) | ❌                                                                  | ✅                                                              | ✅                                                   | Same as above; LAN transport                                                                                                                              |
| Cash drawer (kicked from printer) | ⚠️ when ESC/POS printer is browser-reachable                       | ✅                                                              | ✅                                                   | `drivers/EscPosCashDrawerDriver.ts`                                                                                                                      |
| Customer / line display | ⚠️ via WebUSB on supported displays                                     | ✅                                                              | ✅                                                   | `drivers/CustomerDisplayDriver.ts`, `drivers/LineDisplayDriver.ts`                                                                                       |
| Payment terminal (PAX / Verifone / Stripe) | ❌                                                                  | ✅                                                              | ✅                                                   | `drivers/PaymentTerminalDriver.ts` — vendor SDK; see `pos_terminal_provider_configs`                                                                     |
| Weighing scale (serial)  | ⚠️ via WebSerial                                                        | ✅                                                              | ✅                                                   | `drivers/SerialScaleDriver.ts`                                                                                                                            |
| Biometric attendance device (ZKTeco / Suprema / Hikvision) | ❌                                              | ⚠️ (vendor SDK varies)                                          | ✅ (planned — see ADR-0037)                          | LAN-agent only; saga handlers + roles already registered, transport pending                                                                              |

## Execution topology rules

1. **Browser-only deployments** are limited to PDF/A4 print, keyboard-wedge
   scanners, and (where the OS exposes them) WebUSB / WebHID / WebSerial
   devices. No raw TCP, no vendor SDKs, no native HID outside WebHID.
2. **Electron deployments** unlock native USB, raw 9100 ESC/POS, vendor
   SDKs (Epson ePOS, Star, Zebra), and payment-terminal SDKs.
3. **LAN agent** (planned) is the recommended path for shared hardware
   that must be reachable from any cashier station on the same network —
   network ESC/POS printers, back-office label printers, biometric devices.
   See `services/hardware/local-agent/` for the protocol skeleton.

## Audit & governance

Every hardware op — original or reprint — passes through
`HardwareClient.exec`, which writes a row to `hardware_exec_log` with
`source_doc_type`, `source_doc_id`, `business_event_id`, and `is_reprint`
populated. Reprints additionally create a row in `reprint_requests` via
the `request_reprint` RPC (see `services/printing/reprintClient.ts`).

The `/admin/hardware-ops` operator dashboard surfaces queue health, failed
events, the SharedCommandQueueWorker leader status, and manual
reclaim/retry.

## Related ADRs

- [ADR 0037 — Hardware execution topology](./decisions/0037-hardware-execution-topology.md)
