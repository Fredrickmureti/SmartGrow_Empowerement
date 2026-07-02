# ADR-0014: POS hardware — main-process orchestrator (Square × Odoo hybrid)

Date: 2026-05-18
Status: Accepted
Supersedes: parts of the renderer-side `HardwareProxy` singleton (kept as a
thin RPC client behind `HardwareClient` during the migration window).

## Context

The Electron POS owns receipt/kitchen printers, cash drawers, scales,
scanners, customer displays and (eventually) EMV payment terminals.
The pre-existing implementation put the device-lifecycle singleton
(`HardwareProxy`) in the renderer bundle, with drivers also in the renderer
and parallel `usb:*` / `serial:*` IPC channels in main that bypass the
driver layer entirely. Findings A–J of the audit
(`docs/audit/2026-05-18-pos-hardware-architecture.md`) catalogue the
consequences: lost receipts on tab close, double USB claims across windows,
a silent-no-op cash-drawer kick (`ipcMain.emit` mis-use), fire-and-forget
sale → print → drawer → GL flow with no replay path.

The previous agent stopped on five "open questions" before continuing.
Per the engineering directive ("don't push architectural decisions back to
the user"), this ADR records the chosen defaults.

## Decision

1. **The Electron main process is the primary device orchestrator.**
   `DeviceManager` in `electron/hardware/` owns driver instances, per-device
   mutexes and the health-check loop. The renderer expresses intent only,
   through a single capability-scoped IPC channel (`pos:exec`).

2. **The `agent/` HTTP sidecar is retained as an optional secondary
   orchestrator** for shared/network printers (kitchen printer used by
   multiple terminals, label printer at receiving). It is no longer the
   default path for terminal-local devices. Pattern reference: Odoo IoT
   Box for shared devices, Square in-process orchestrator for
   terminal-local devices (`docs/architecture/POS_HARDWARE_INDUSTRY_NOTES.md`).

3. **Cross-platform priority: Windows + Linux first**, macOS as a follow-up.
   Matches `electron/README.md` and the existing `scripts/package-electron.mjs`.

4. **Payment terminal: ship the `IPaymentTerminalDriver` interface and EMV
   state machine now; first vendor adapter is Stripe Terminal**, layered on
   the same interface. Kenya tenants settle card-present rarely (M-Pesa
   dominates), so the SDK installation is deferred to a focused loop. The
   interface-first approach prevents another rewrite when Verifone /
   Adyen / Ingenico are added.

5. **Bluetooth integrations deferred to v2**, but the transport seam
   (`BluetoothTransport` via `noble` in main, persistent pairing table) is
   shipped now. WebBluetooth from the renderer is rejected: its pairing
   model and reconnect story are too brittle for retail floors.

6. **Every hardware command flows through a durable per-device queue**
   backed by the existing encrypted SQLite (`hw_command_queue`). Sale
   commit is a saga with outbox (`pos_outbox`) and crash-replay on app
   start. Idempotency keys are required.

## Consequences

- Renderer bundle shrinks (drivers move out next loop).
- A single `pos:exec` channel replaces the ~12 raw IPC channels
  (`usb:print`, `usb:open-drawer`, `serial:write`, etc.). Preload's
  `window.pos.*` surface is the only sanctioned API.
- Closing the POS tab no longer destroys device state.
- Receipts and drawer kicks survive crashes (replay from outbox).
- The renderer-side `HardwareProxy` becomes a thin client behind
  `HardwareClient`; legacy `PrinterService` / `CashDrawerService` /
  `ScaleService` / `CustomerDisplayService` / `IoTBoxClient` /
  `ElectronBridge` are scheduled for deletion once the UI migration to
  `HardwareClient` is complete.

## Status of dependent decisions

| Decision | Owner | Status |
|---|---|---|
| Driver migration `src/services/hardware/drivers/` → `electron/hardware/drivers/` | follow-up loop | scheduled |
| Replace legacy `usb:*` / `serial:*` IPC channels (mark deprecated, then delete) | follow-up loop | preload deprecation shipped this loop |
| CSP, `setPermissionRequestHandler`, agent HMAC + 127.0.0.1 bind | Phase 5 | scheduled |
| Stripe Terminal adapter | Phase 4 | scheduled |
| CUPS + Windows print-spooler transports | Phase 4 | scheduled |
