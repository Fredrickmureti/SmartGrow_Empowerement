# Hardware Platform — Wave 9d (Capability probe + runtime card + docs)

## Independent re-audit of Wave 9b/9c (verified before starting 9d)

Re-ran the prior agent's claims by walking the code. Everything checks out:
pages live under `src/apps/platform/hardware/`, `pos_hardware_configs` is
dropped, `DeviceRegistryCard` and `useHardwareProxy` are out of POS, the
`useInventoryLabelPrinter` scope hack is gone, and all four arch guards
(`hardware-not-pos-scoped`, `hardware-single-chokepoint`,
`hardware-driver-duplication`, `no-raw-electron-api`) exist and pin the
contract. No silent regressions found.

The "fragmented / confused" symptom the user described is real, but the
prior waves have shrunk it substantially. The remaining work is the
capability layer (this wave), driver-code collapse (9d.2), and the first
live cross-module consumer (9f).

## Shipped this wave

### 1. Runtime capability probe — end to end

| Layer | Change |
|---|---|
| Main IPC | `electron/main.ts` registers `pos:hardware:capabilities`. Lazy-imports each transport module (`usb`, `serialport`, `node-hid`, `net`, `child_process`) and reports `native` / `unavailable` per the load result. Never opens devices — strictly read-only. |
| Preload | `electron/preload.ts` exposes `pos.hardware.capabilities()` through `ipcRenderer.invoke('pos:hardware:capabilities')`. Bumped `preloadBuild` to `9d-2026-06-04` so diagnostics can see whether the runtime is on the new bundle. |
| Types | `src/types/electron.d.ts` adds `HardwareCapabilitiesSnapshot` + `HardwareTransportState` and threads them through `PosHardwareAPI`. |
| Client | `src/services/hardware/HardwareClient.ts` adds `runtimeCapability(): Promise<RuntimeCapability>` plus `invalidateRuntimeCapability()`. Three branches: Electron (preload), IoT-agent (`AgentClient.probe()`), browser (feature-detect). Cached 5s. |
| UI | `src/apps/platform/hardware/HardwareDevices.tsx` Runtime card now renders the live probe — runtime kind, preload build, color-coded transport list, warnings (e.g. "WebUSB unavailable — Chromium/Edge required"). Replaces the static "browser mode" copy. |
| Test | `src/test/hardware/runtime-capability.test.ts` covers the browser/unsupported branch, the Electron branch, the warning surface, and the cache. |

### 2. Console.log cleanup

Stripped the three `[LIFECYCLE] useHardwareProxy …` console.log calls in
`src/hooks/hardware/useHardwareProxy.ts` (lines 119, 276, 278). They were
firing on every render across `POSTerminal`, `POSSettings`,
`PostPaymentScreen`, `ReceiptPreviewDialog`, `PrintPreviewDialog`,
`DeviceRegistryCard` — production noise.

Also removed the duplicate `console.info('[hardware-devices] mounted', …)`
in `HardwareDevices.tsx` — its content is now subsumed by the live
Runtime card and the diagnostics page.

### 3. Docs rewritten

- `docs/architecture/HARDWARE_RUNTIME.md` — full rewrite. Runtime
  matrix, single-chokepoint contract, driver-ownership rule, capability
  probe spec, fallback hierarchy, ASCII command/event flow, "where to
  add a new device" checklist, wave history.
- `docs/architecture/HARDWARE_CAPABILITY_MATRIX.md` — new. Transport ×
  runtime table, role × op × driver table, fallback hierarchy,
  operator-visible warnings list.
- `src/services/hardware/README.md` — rewritten. Dropped the
  `pos_hardware_configs` framing, scoped to "what's in this directory",
  links to the architecture docs.

### 4. Memory

- `mem/features/hardware-platform.md` — rewritten for the post-9d
  invariants. Captures: single chokepoint, driver-ownership rule,
  capability probe contract, never-touch lists.

## Deferred (with reason)

### Wave 9d.2 — Driver code collapse + guard inversion

Reduce renderer-side `EscPosPrinterDriver`, `EscPosCashDrawerDriver`,
`CustomerDisplayDriver`, `SerialScaleDriver`, `EposPrinterDriver`,
`HidScannerDriver`, `PaymentTerminalDriver`, `LineDisplayDriver` to thin
descriptors. Keep `BrowserPrintDriver` + `KeyboardScannerDriver` as the
only renderer-executing drivers. Invert
`hardware-driver-duplication.test.ts` to *forbid* renderer-side
execution code instead of merely flagging it.

Reason for deferral: this is a high-mechanical-volume refactor across
eight driver files, plus a non-trivial shape change to
`BrowserHardwareAdapter` (which currently calls into the renderer
drivers directly). The driver-ownership rule is now memorialized in
`HARDWARE_RUNTIME.md` and the project memory, so the contract is in
place — only the code mass-edit is outstanding. Worth a dedicated turn
with a focused checklist instead of bundling it with the probe ship.

### Wave 9e — TanStack routing canary (cancelled)

Initial plan called for adding TanStack mirrors for the
`/pos/hardware-*` redirects so they survive a future
react-router-dom → TanStack migration. After reading
`src/routes/index.tsx` and `src/routes/$.tsx` I confirmed the entire
SPA is splatted into TanStack via `<App />`. Adding TanStack page files
for those paths would *preempt* the splat and break the redirects,
which are already correctly handled by `<Navigate>` inside
react-router-dom. There is no real TanStack page tree to canary
against. **Cancelled** — no work needed.

### Wave 9f — Inventory label-print live wiring

`useInventoryLabelPrinter` is scope-clean and importable, but
`src/pages/Products.tsx` (1475 lines) needs a UX decision (row action
vs bulk action; ZPL vs ESC/POS label format; server-side render vs
client). Documented in `.lovable/plan.md` §C; left for a focused turn.

## Validation

```text
bunx vitest run src/test/architecture src/test/hardware src/test/pos
```

Expected: all existing guards stay green; new `runtime-capability.test.ts`
passes.

## Files changed

```text
electron/main.ts                                            edit  +47 / -2  (added pos:hardware:capabilities handler)
electron/preload.ts                                         edit  +10 / -2  (added hardware.capabilities, bumped preloadBuild)
src/types/electron.d.ts                                     edit  +21 / -4  (HardwareCapabilitiesSnapshot, threaded into PosHardwareAPI)
src/services/hardware/HardwareClient.ts                     edit  +127 / 0  (runtimeCapability + invalidateRuntimeCapability)
src/apps/platform/hardware/HardwareDevices.tsx              edit  +56 / -19 (live Runtime card; removed [hardware-devices] mount log)
src/hooks/hardware/useHardwareProxy.ts                      edit  +3 / -5   (stripped [LIFECYCLE] console.log calls)
src/services/hardware/README.md                             rewrite        (drop pos_hardware_configs framing)
docs/architecture/HARDWARE_RUNTIME.md                       rewrite        (post-9d runtime story)
docs/architecture/HARDWARE_CAPABILITY_MATRIX.md             new            (capability matrix reference)
mem/features/hardware-platform.md                           rewrite        (post-9d invariants)
src/test/hardware/runtime-capability.test.ts                new            (probe shape coverage)
docs/audit/2026-06-04-hardware-wave-9d.md                   new            (this doc)
```

## What the user asked for vs what shipped

| User concern | Status |
|---|---|
| "Is the system actually confused / fragmented?" | Re-audited. Wave 9b/9c work is real; remaining fragmentation is the four items listed in `.lovable/plan.md` §B. |
| "Unify Electron / IoT-agent / browser story" | `runtimeCapability()` is now the single authoritative probe; doc + matrix codify the contract. |
| "Hardware should be platform, not POS" | Already shipped in Wave 9b/9c (re-verified). Memory updated to prevent regression. |
| "Electron scan actions appear broken" | Not addressed by this wave directly; the capability probe + warnings now make stale-preload / missing-transport conditions visible in the Runtime card, which was the root cause of the symptom. |
| "Hardware management feels disconnected" | Live Runtime card + diagnostics page link makes the runtime state explicit on the device page. |
| "Driver duplication" | Memorialized rule + audit doc; physical code collapse deferred to 9d.2. |
