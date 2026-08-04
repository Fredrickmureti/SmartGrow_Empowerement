# Hardware Runtime (post Wave 9d)

> Single authoritative description of how device commands flow from a
> React component to a physical peripheral, across all three supported
> runtimes. If a code path contradicts this doc, the doc wins — fix the
> code. See also `HARDWARE_CAPABILITY_MATRIX.md` for the transport/op
> matrix.

## Runtimes

| Runtime | When | Who owns transports |
|---|---|---|
| **Electron (desktop POS)** | Packaged desktop client. `window.pos.hardware.exec` present. | Main process — `electron/hardware/DeviceManager` + per-role drivers in `electron/hardware/drivers/`. |
| **IoT agent** | Browser tab with `localhost:8043` reachable. | The local agent process (separate repo under `/agent`). Renderer is a pure HTTP client. |
| **Remote IoT agent (relay)** | Browser tab that cannot reach loopback (e.g. https site, phone). Dispatch is queued to a workstation over Supabase `edge_jobs` and executed by that machine's agent. | The remote agent process. The browser owns nothing. |
| **Browser-only** | PWA / mobile-web POS, no agent, no Electron. | The renderer itself via WebUSB / WebSerial / WebHID. Last-resort fallback. |
| **Unsupported** | Browser without WebUSB/WebSerial/WebHID. | None. Hardware ops return `{ success: false, error: 'transport unavailable' }`. |

`hardwareClient.runtimeCapability()` returns which runtime is active plus
the live transport/op matrix. The Runtime card on
`/platform/hardware/devices` renders it.

## Single chokepoint

All UI / hooks / pages call `hardwareClient` (from
`src/services/hardware/HardwareClient.ts`). The chokepoint dispatches:

```text
hardwareClient.exec({ role, op, payload, idempotencyKey })
        │
        ├── ipcAvailable()      → execElectron → window.pos.hardware.exec
        │                              │
        │                              └── (main) CommandRouter → DeviceManager
        │                                                       → Driver (electron/hardware/drivers/*)
        │                                                       → Transport (USB / Serial / Network / CUPS / BT)
        │                                                       → Physical device
        │
        └── otherwise          → browserHardwareAdapter.exec
                                       │
                                       ├── local agent reachable → AgentClient (HTTP to localhost:8043)
                                       ├── relay enabled          → RelayTransport → edge_jobs → remote agent poll
                                       └── pure browser           → renderer driver (WebUSB / WebSerial / WebHID)
```

Documents take one of two dispatch paths, both landing on the same seam:

```text
foreground   PrintService.printDocument → policy → print_jobs (ledger)
                                        → render → dispatch.toDevice
                                        → execForIntent → resolve_device
                                        → hardwareClient.execAssignment

recovery     print_jobs (queued) → dispatch-print-jobs (edge fn, SKIP LOCKED,
                                   back-off, DLQ) → workstation relay
```

## Readiness (registry + heartbeat, never the local probe)

"Can this intent print?" is answered by **one** service:
`src/services/hardware/readiness.ts` (`resolveIntentReadiness`, and the
`useIntentReadiness` hook).

It asks the platform, not the local transport:

1. Is a `device_assignments` row bound for the intent? (`resolve_device`)
2. Does a workstation own it, and did that workstation poll within
   `WORKSTATION_LIVENESS_WINDOW_MS` (20 s, matching `RelayTransport`)?
3. Otherwise, can this runtime (Electron / loopback agent) serve it?

States: `ready`, `no_device_bound`, `workstation_offline`, `degraded`,
`local_only_unavailable`, `unknown` — each carrying operator-facing copy, so
the UI never shows a flat "No printer connected" again.

`hardwareClient.devices.getStatuses()` is a **local runtime diagnostics
probe only**. Using it to gate printing is what made POS report "No printer
connected" while invoice/label printing worked over the relay.

## Connection ownership

`EdgeRelayMount` is the **single owner** of the renderer adapter registry:
the only caller of `devices.loadAssignments()` and `devices.connectAll()`.
`useHardwareProxy` is a read-only status/action façade. Two writers
previously raced over the same singleton, so the later mount wiped the
other's device list and hardware settings on one machine disturbed another
session. Workstation selection applies the liveness window; assignments are
never cleared merely because a query is still in flight.

Guard: `src/test/architecture/hardware-readiness-single-source.test.ts`.

Guards that pin this contract:

- `src/test/architecture/hardware-single-chokepoint.test.ts` — no `src/`
  file touches `window.pos.usb|serial|hid` directly outside the allow-list.
- `src/test/pos/no-raw-electron-api.test.ts` — no `ipcRenderer`,
  `window.electronAPI`, or `from 'electron'` in `src/`.
- `src/test/architecture/hardware-not-pos-scoped.test.ts` — hardware
  components and hooks live under `*/hardware/`, never `*/pos/`.
- `src/test/architecture/hardware-driver-duplication.test.ts` — every
  renderer driver overlapping a main driver is flagged `browserFallback:
  true`. (Pending Wave 9d.2 inversion — see "Driver ownership" below.)

## Driver ownership

**Rule:** The main-process driver is authoritative. Renderer-side drivers
exist only for genuinely browser-only fallback (WebUSB ESC/POS, keyboard
wedge scanner) and for the BrowserHardwareAdapter dev preview.

| Driver class | Main (`electron/hardware/drivers/`) | Renderer (`src/services/hardware/drivers/`) |
|---|---|---|
| ESC/POS receipt / kitchen | authoritative | browser fallback only |
| ESC/POS cash drawer | authoritative | browser fallback only |
| Customer display | authoritative | browser fallback only |
| Serial scale | authoritative | browser fallback only |
| Epos LAN printer | authoritative | browser fallback only |
| Keyboard wedge scanner | n/a | renderer-primary (window keystroke listener) |
| Browser print fallback | n/a | renderer-primary (window.print / PDF) |

Adding new device support → put the real work in
`electron/hardware/drivers/<NewDriver>.ts` and register it in
`electron/hardware/drivers/index.ts`. The renderer copy, if any, must
forward `exec` through `hardwareClient` and never open a transport
directly.

## Capability probe

`runtimeCapability()` returns `{ runtime, platform, preloadBuild,
transports: { usb, serial, hid, network, cups, bluetooth }, ops,
warnings }`. Cached for 5s; call `invalidateRuntimeCapability()` after
agent reconnect, after `pos.hardware.exec` reports a transport failure,
or when an operator triggers Reconnect from the Runtime card.

In Electron the probe asks the preload (`window.pos.hardware.capabilities()`)
which in turn asks the main-process IPC handler `pos:hardware:capabilities`.
The handler attempts a lazy `import()` of each transport-backing module
(`usb`, `serialport`, `node-hid`, `net`) and reports `native` /
`unavailable` per the load result. No devices are opened — the probe is
read-only.

In browser-only mode the probe feature-detects `'usb' in navigator`,
`'serial' in navigator`, `'hid' in navigator`.

In IoT-agent mode the probe maps the agent's `/healthz` response into
the same shape.

## Fallback hierarchy

For each `(role, op)`:

1. **Electron native** if `ipcAvailable()` — preferred always.
2. **IoT agent** if running and authorized — chosen by the browser
   adapter's transport resolver.
3. **Browser-native** (WebUSB / WebSerial / WebHID) — last resort, with
   user permission prompt.
4. **Unsupported** — return `{ success: false, error: 'transport
   unavailable' }`. UI must surface a clear "open in the desktop client or
   install the local agent" message.

## Command + event flow (ASCII)

```text
                  ┌────────────────────────────────────────────────┐
                  │ React component / hook                         │
                  │  (e.g. POSTerminal, useInventoryLabelPrinter)  │
                  └────────────────┬───────────────────────────────┘
                                   │ hardwareClient.exec(...)
                                   ▼
                  ┌────────────────────────────────────────────────┐
                  │ HardwareClient (single chokepoint)             │
                  └────────────────┬───────────────────────────────┘
                                   │
                ┌──────────────────┴──────────────────┐
                ▼                                      ▼
   ┌──────────────────────────┐         ┌──────────────────────────┐
   │ Electron preload         │         │ BrowserHardwareAdapter   │
   │ window.pos.hardware.exec │         │   ├─ AgentClient (HTTP)  │
   └────────────┬─────────────┘         │   └─ DriverRegistry      │
                │ ipcRenderer.invoke    └────────────┬─────────────┘
                ▼                                      │
   ┌──────────────────────────┐                       │
   │ Main: CommandRouter      │                       │
   │  → DeviceManager         │                       │
   │  → CommandQueue (retry)  │                       │
   │  → Driver                │                       │
   │  → Transport             │                       │
   └────────────┬─────────────┘                       │
                ▼                                      ▼
            ┌─────────────────────────────────────────────┐
            │              Physical device                │
            └─────────────────────────────────────────────┘

Event return path: device events → EventBroker → ipcRenderer.send('pos:event')
→ preload subscribe → HardwareEventBus → React subscribers.
```

## Where to add a new device

1. Create the main-process driver in `electron/hardware/drivers/`,
   extending `BaseDriver`. Implement `onConnect`, `onHealthCheck`,
   `handle(cmd)`, `supportedOps()`.
2. Register it in `electron/hardware/drivers/index.ts` so DeviceManager
   can instantiate it from a `device_assignments` row.
3. Add the transport (if new) under `electron/hardware/transports/`.
4. If browser fallback is needed, add a thin renderer driver under
   `src/services/hardware/drivers/` that *only* forwards `exec`
   through `hardwareClient`. Register it with `browserFallback: true`.
5. Add a row in `pos_cash_movement_types` / `pos_registers` settings if
   the device needs configurable behavior (e.g. drawer auto-kick rules).
6. Update `HARDWARE_CAPABILITY_MATRIX.md` with the new role/op pair.
7. Add a `supabase/tests/*_rls_test.sql` covering the assignment scope.
8. Cover the driver with a unit test in `src/test/pos/` or
   `src/test/hardware/`.

## Wave history

- Wave 9b — page relocation, `pos_hardware_configs` dropped.
- Wave 9c — `DeviceRegistryCard`, `useHardwareProxy` moved out of POS.
- Wave 9d — capability probe, live Runtime card, doc rewrite.
- Wave 9d.2 (open) — collapse renderer driver duplication; invert
  `hardware-driver-duplication.test.ts` to forbid renderer execution
  code outside `BrowserPrintDriver` + `KeyboardScannerDriver`.
- Wave 10 — one readiness service (`readiness.ts`), one connection owner
  (`EdgeRelayMount`), relay + queue drain documented as first-class.
- Wave 9f (open) — first live cross-module consumer
  (`useInventoryLabelPrinter` on Products page).
