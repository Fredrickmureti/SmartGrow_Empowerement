# Hardware Platform — Wave 9 Re-Audit & P0 Regression Fix

## Part 1 — Independent verification of Wave 7 + Wave 8 claims

I walked the code, not the prior summaries. Most claims hold; one does not.

| Prior claim | Verdict | Evidence |
|---|---|---|
| Wave 7 — Runtime Decisions panel + Copy diagnostics in `HardwareDiagnostics.tsx` | Verified | `getRecentRuntimeReasons` ring buffer in `HardwareClient.ts` L72–115, polled and rendered in the diagnostics page. |
| Wave 7 — `useHardwareProxy` migrated off the deprecated shim | Verified | no `useDeviceRegistry` import remains; reads `useDeviceAssignments` via private compat adapter. |
| Wave 7 — `useInventoryLabelPrinter` hook + arch test | Verified — but **no live UI consumer**. The seam is proven by a test, not by a real cross-module flow. |
| Wave 8 — `useDeviceRegistry` reduced to deprecated re-export | Verified | 22-line shim re-exports `useHardwareRegistryCrud`. |
| Wave 8 — ESLint allow-list emptied of consumers | Verified | `no-legacy-device-registry.js` only allows the shim file itself. |
| Wave 8 — POS Settings hardware tab is redirect-only CTA | Verified | `POSSettings.tsx` L1001–1030 + arch test `pos-settings-no-hardware-editor`. |
| Wave 8 — "Single source of truth: Platform → Hardware" | **FALSE — silent P0 regression.** See Part 2. |

## Part 2 — P0 finding: Wave 8 deleted the production hardware editor

`src/components/pos/DeviceRegistryCard.tsx` (1218 lines) is the **only UI**
in the codebase that exposes:

- Scan for Devices (WebUSB / WebSerial / WebHID)
- Add Device manually (network IP/port, USB VID/PID, serial port)
- Driver picker (escpos / star / citizen / epos / scale / drawer / display)
- Role assignment (receipt / kitchen / drawer / scale / display / terminal / scanner / label)
- IoT agent URL + token configuration
- Per-device loopback test print

Wave 8 Batch E removed its mount from POS Settings and told operators to
"open Platform → Hardware". But `src/pages/pos/HardwareDevices.tsx` — the
page behind both `/platform/hardware/devices` and the legacy
`/pos/hardware-devices` — never mounted it. Until Wave 9 the page only
rendered a read-only role list with `Test` + `Remove` buttons.

Net effect in the deployed app: users could list and remove existing
assignments, but had **no UI to add, scan, edit, choose a driver, or
configure the agent** anywhere. The "scan does nothing / device discovery
does not respond" complaints in the audit prompt were literally accurate —
the scan dialog was unreachable from any route.

This was the single most damaging fragmentation symptom in the module and
the root cause of the "hardware management feels disconnected" perception.

## Part 3 — Shipped this wave

### Batch A — Restored the hardware editor on the platform page (P0)

- `src/pages/pos/HardwareDevices.tsx` now imports and renders
  `<DeviceRegistryCard registerId={undefined} />` below the role summary,
  so `/platform/hardware/devices` finally owns scan / add / edit / driver
  pick / role assignment / agent config / loopback test.
- The legacy "browser mode" banner was replaced with an honest "Runtime"
  card that names the current dispatch path (Electron IPC vs Browser/PWA)
  and links to `/platform/hardware/diagnostics` for triage.
- New architecture guard `src/test/architecture/platform-hardware-has-editor.test.ts`
  asserts the page imports and renders `DeviceRegistryCard` and links to
  the diagnostics page. Prevents another silent removal.

### Batch F — Documentation

- This audit doc.

## Part 4 — Explicitly deferred to a follow-up wave (with reason)

These were scoped in the Wave 9 plan but deliberately kept out of this
commit to keep the P0 fix small and reviewable. Each gets its own focused
turn:

| Item | Reason for deferral | Tracked as |
|---|---|---|
| Move `HardwareDevices.tsx` / `HardwareDiagnostics.tsx` from `src/pages/pos/` to `src/apps/platform/hardware/` | Pure file move with many test/route consumers; no architectural payoff once the editor is mounted. | Wave 9b — pair with shim deletion. |
| Delete `useDeviceRegistry.ts` shim + `no-legacy-device-registry` ESLint rule | Zero call sites today, but keep one release of the re-export so any in-flight branch still compiles. | Wave 9b. |
| Drop `pos_hardware_configs` + reverse-mirror trigger | One more release on the reverse mirror first; needs a pre-migration row-diff check. | Wave 9b. |
| Wire first live `useInventoryLabelPrinter` consumer | Needs a real Inventory entry surface; pick the right one during implementation, don't invent. | Wave 9c. |
| Physical collapse of duplicated drivers in `src/services/hardware/drivers/*` | Per-driver removal; the `browserFallback` invariant + arch test already prevent new duplication. | Wave 9d. |
| Phase 5 native discovery (USB / mDNS / BLE in Electron main) | Separate plan; the missing UI was P0 first. | Separate plan. |
| EMV state machine, native scanner SDKs | Vendor-specific tracks. | Separate plans. |

## Part 5 — Files changed this wave

```text
src/pages/pos/HardwareDevices.tsx                                NEW import + editor mount + runtime card
src/test/architecture/platform-hardware-has-editor.test.ts       NEW — guard
docs/audit/2026-06-01-hardware-wave-9.md                         NEW — this doc
```

No DB migrations. No driver-tree changes. No new dependencies.

## Part 6 — Rollback

- Revert the three lines in `HardwareDevices.tsx` (import, runtime card,
  `<DeviceRegistryCard />` mount) and delete the new architecture test.
  The shim, the legacy table, and the duplicate drivers are all untouched
  by this wave.

## Part 7 — Net effect

After Wave 9:

- `/platform/hardware/devices` is now genuinely the single hardware-editor
  surface: scan, add, edit, choose driver, assign role, configure the IoT
  agent, loopback test — all reachable from one route, in both browser and
  Electron runtimes.
- The "Test requires desktop" copy is gone; users see an honest runtime
  description and a direct link to diagnostics when something is wrong.
- A guard test locks the editor onto this page so the next refactor can't
  silently orphan it again.

The mechanical cleanups the previous wave promised for Wave 9 (shim
deletion, legacy-table drop, page relocation, driver collapse, Inventory
wiring) are documented above as explicit follow-ups rather than declared
done — keeping the audit log honest, per the audit prompt's rules.
