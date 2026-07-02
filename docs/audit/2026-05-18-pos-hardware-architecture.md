# POS Hardware Architecture — Zero-Trust Audit
_Date: 2026-05-18_

Full plan: `.lovable/plan.md` (approved). This document is the durable audit record.

## Scope
Electron POS hardware-integration stack: renderer drivers in `src/services/hardware/`, main process (`electron/main.ts`, ~1013 LOC, ~63 IPC channels), the standalone HTTP sidecar in `agent/`, and the device tables already in Supabase.

## Findings (severity ordered)

| # | Severity | Area | Finding |
|---|----------|------|---------|
| A | Critical | Layering | Renderer owns device lifecycle. `hardwareProxy` is a React-bundle singleton; `node-usb` and `serialport` claimed in main but parallel IPC channels (`usb:print`, `serial:write`) bypass the HAL. |
| B | Critical | Orchestration | No `DeviceManager`, no per-device mutex, no command queue. `activeSerialPort` is a process-global. `usb:open-drawer` calls `ipcMain.emit` (event-bus path), not the registered handler — drawer kicks silently no-op. |
| C | High | Atomicity | Sale completion = independent fire-and-forget hardware + GL calls. No outbox, no saga, no replay log. Printer failure after a posted sale loses the receipt. |
| D | High | Security | Preload exposes `serial:*`, `usb:*`, `secure-storage:*` without capability scoping. No CSP, no permission handler, no navigation lockdown. Agent binds `0.0.0.0`, uses static file token, has `AGENT_AUTH_DISABLED` escape hatch. |
| E | High | Cross-platform | USB claim assumes `interfaces[0]`/`endpoints.find(out)` — breaks on Epson TM-m30, Star mC-Print, Zebra. No CUPS or Windows-spooler transport — driver-installed printers cannot print. |
| F | High | Offline resilience | SQLite + KeyManager + BackupScheduler exist; no durable hardware-command queue. Crash mid-sale = lost receipt and drawer kick. |
| G | Medium | Events | `HardwareEventBus` is renderer-only. Customer-display BrowserWindow receives nothing. No central broker. |
| H | Medium | Lifecycle | `healthCheck()` method exists, is never scheduled. HID scanner listens on renderer `keydown` — scans lost when focus is on customer display, modal, kitchen window. |
| I | High | Payments | `PaymentTerminalDriver` is a stub. No EMV state machine, no settlement reconciliation. |
| J | Medium | Testing | Coverage limited to `parseBarcode`, `scanBus`, `scanRouter`. No driver, transport, queue, or IPC-contract tests. |

## Target architecture
See `.lovable/plan.md` §2 for the layered diagram (Renderer → DeviceManager → CommandQueue → Saga/Outbox → HAL → OS).

Non-negotiables:
1. Renderer expresses **intent only**; main process executes.
2. Every hardware command is enqueued with an idempotency key.
3. Sale → print → drawer → display → GL runs as a saga backed by an outbox table.
4. Preload is a capability-scoped `window.pos.*` allow-list.

## Roadmap (7 phases)
0. Decision gate (3 user inputs: agent retention, OS priority, payment vendor).
1. **Foundation** — `HardwareClient` facade, baseline tests, lint guard, scoped preload.
2. **Move orchestration to main** — `DeviceManager`, drivers in main, single `pos:exec` channel, `pos:event` broadcast.
3. **Durable queue & saga** — `hw_command_queue`, `pos_outbox`, replay on app start.
4. **Driver hardening** — CUPS / Windows spooler / VID-PID table, scale protocols, BT design, payment terminal end-to-end.
5. **Security** — CSP, permission handler, agent loopback bind + HMAC.
6. **CI matrix** — Win + Linux smoke tests.
7. **Observability** — per-device latency histograms surfaced in Admin → Infrastructure.

## Industry references
See `docs/architecture/POS_HARDWARE_INDUSTRY_NOTES.md` for the Odoo / Square / Shopify / Lightspeed / Toast / NCR comparison and the rationale for the chosen pattern.

## Implementation status
- Phase 0: documented; user decisions pending.
- Phase 1.1: `HardwareClient` facade shipped (`src/services/hardware/HardwareClient.ts`).
- Phase 1.2: baseline role-routing tests shipped (`src/test/pos/hardware-proxy.test.ts`).
- Phase 1.3 – 7: pending.