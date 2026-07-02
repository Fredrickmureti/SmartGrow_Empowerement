# POS Hardware Architecture — Industry Notes

Reference material for the audit in `docs/audit/2026-05-18-pos-hardware-architecture.md`.

## How the majors do it

| System | Process model | HAL location | Queue / saga | Notes |
|--------|---------------|--------------|--------------|-------|
| **Square POS** | Native iOS/Android app; first-party readers via BLE/Lightning/USB-C. | In-app SDK in the native process; no separate sidecar. | App-side outbox; offline tx persisted, settled when online. | Vertically integrated hardware → tight pairing UX, narrow device matrix. |
| **Shopify POS** | Native iOS/Android; printers via Star/Epson SDKs over LAN or BT. | SDK in app process. | In-app retry queue; receipts re-printable from order detail. | Cloud-first; offline mode limited. |
| **Lightspeed Retail (X-Series)** | Web app + small native helper ("Lightspeed Hub") for USB/serial. | Helper exposes a local HTTP API to browser. | Helper queues print jobs locally. | Same shape as the project's `agent/` sidecar. |
| **Toast POS** | Custom Android handhelds + Toast-managed terminals. | Vendor-controlled OS + app. | Server-side outbox in Toast cloud; device replays on reconnect. | Pure walled garden. |
| **Odoo POS (16/17)** | Browser POS + IoT Box (Raspberry Pi running a Python daemon) for shared hardware; alt. local install of the daemon on Windows/Linux. | IoT Box owns drivers, exposes longpoll + REST. | Browser has a `paid_order` queue persisted in IndexedDB; IoT Box is mostly stateless. | The closest analogue to where this project is heading. |
| **ERPNext POS** | Browser; printing via QZ Tray or browser print. | Out-of-process (QZ). | Browser IndexedDB offline. | Weakest of the bunch — production deployments tend to add custom Electron wrappers. |
| **Oracle MICROS / NCR Aloha** | Thick Windows clients (Simphony, Aloha) with vendor drivers. | In-process drivers + OPOS/UPOS abstraction layer. | Local store DB acts as outbox, settles to corporate. | OPOS/UPOS is the canonical retail HAL standard — worth borrowing the device-class taxonomy. |
| **Zebra ecosystems** | Android with EMDK / DataWedge for scanners. | Vendor SDK injects scans as intents. | N/A (input device only). | Pattern for the keyboard-wedge scanner replacement. |

## Patterns worth borrowing

1. **Odoo-style sidecar IoT Box** when hardware is shared across multiple terminals (kitchen printer, weigh-station scale, label printer at receiving). Single point of control, single firmware to update.
2. **Square/Toast-style in-process orchestrator** when the device is dedicated to the terminal (drawer, scanner, receipt printer). Lowest latency, simplest crash story.
3. **OPOS/UPOS device-class taxonomy** (PosPrinter, CashDrawer, Scanner, Scale, LineDisplay, MSR, PinPad) as the canonical `DeviceRole` enum. The current enum is already close.
4. **Per-device command queue with idempotency** (Toast, Square offline) — the single change that prevents lost receipts.
5. **Outbox + saga** for cross-cutting "sale committed" events (Odoo `pos.order` queue is the reference).

## Chosen direction for this codebase

Hybrid Square × Odoo:
- **Main-process `DeviceManager` is the primary orchestrator** (Square pattern) — dedicated devices, lowest latency, crash recovery owned by Electron.
- **The `agent/` sidecar is retained for shared / network printers and devices that need to outlive a single terminal session** (Odoo IoT Box pattern), pending user confirmation in Phase 0.
- **OPOS-style role taxonomy** stays in `DeviceRole`.
- **Durable per-device queue + saga outbox** lives in the Electron SQLite (already encrypted).
- **Bluetooth via `noble` in main**, not WebBluetooth in the renderer — WebBluetooth's pairing model and reconnect story are too brittle for retail floors.

## Anti-patterns to avoid (observed in current code)

- React component → `device.open()` → ESC/POS bytes. (Couples UI re-render to hardware lifecycle.)
- `usb:print` and `serial:write` exposed as raw IPC channels to any renderer code.
- Singletons reset by tab close.
- `ipcMain.emit` used to chain handlers (silent no-op).
- Renderer `keydown` as the only scanner input path (loses focus = loses scans).
- "Offline queue" that only covers Supabase writes, not hardware side-effects.