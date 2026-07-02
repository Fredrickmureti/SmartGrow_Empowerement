# Hardware service layer (post Wave 9d)

> Renderer-side facade for hardware operations. The authoritative runtime
> story lives in `docs/architecture/HARDWARE_RUNTIME.md`; this README
> covers only what's inside this directory.

## What this layer does

- Exposes `hardwareClient` — the **single chokepoint** every UI / hook /
  page in `src/` uses to talk to peripherals.
- Routes each `exec({ role, op, payload, idempotencyKey })` call to the
  active runtime: Electron preload, IoT agent, or browser-native driver.
- Reports live runtime capabilities via `runtimeCapability()`.
- Subscribes to device events via `HardwareEventBus`.

## What this layer does NOT do

- It does **not** own production hardware. Main-process drivers in
  `electron/hardware/drivers/` are authoritative.
- It does **not** read or write a per-module device registry. The
  canonical registry is the Supabase table `device_assignments`
  consumed via `useDeviceAssignments` / `useDeviceForRole`. The legacy
  `pos_hardware_configs` mirror was dropped in Wave 9b.
- It does **not** care which app module is calling (POS, Inventory,
  Warehouse, HR, Manufacturing all consume identically).

## Layout

| File / dir | Purpose |
|---|---|
| `HardwareClient.ts` | The single chokepoint. Exports `hardwareClient`, `runtimeCapability`, `getRecentRuntimeReasons`. |
| `BrowserHardwareAdapter.ts` | Renderer-side driver runtime, used when Electron preload is absent. |
| `HardwareEventBus.ts` | Pub/sub for device events on the renderer side. |
| `ElectronAssignmentHydrator.ts` | Mirrors `device_assignments` rows into the Electron-local SQLite cache. |
| `drivers/` | Renderer-side driver descriptors. Browser-only drivers (`BrowserPrintDriver`, `KeyboardScannerDriver`) keep real implementations; overlapping drivers are scheduled to collapse to thin descriptors in Wave 9d.2. |
| `transport/` | Renderer-side transports (`WebUSBTransport`, `LocalAgentTransport`). |
| `interfaces/` | Low-level interface adapters consumed by the browser drivers. |
| `local-agent/` | HTTP client (`AgentClient`) for `localhost:8043`. |
| `local-display/` | Secondary-screen / customer-display client. |
| `escpos-commands.ts` | ESC/POS byte builders shared by the browser fallback drivers. |

## Architecture invariants

- All hardware calls go through `hardwareClient`. Guards:
  `hardware-single-chokepoint.test.ts`, `no-raw-electron-api.test.ts`.
- Hardware components and hooks live under `*/hardware/`, never `*/pos/`.
  Guard: `hardware-not-pos-scoped.test.ts`.
- Main-process drivers are authoritative for every transport-backed
  role. Renderer drivers that overlap must be flagged
  `browserFallback: true` until Wave 9d.2 collapses them entirely.
  Guard: `hardware-driver-duplication.test.ts`.

## Where to go next

- Adding a new device → see "Where to add a new device" in
  `docs/architecture/HARDWARE_RUNTIME.md`.
- Adding a new role/op to the capability table → update
  `docs/architecture/HARDWARE_CAPABILITY_MATRIX.md`.
- Cross-module consumer pattern → `src/hooks/inventory/useInventoryLabelPrinter.ts`
  (reference implementation).
