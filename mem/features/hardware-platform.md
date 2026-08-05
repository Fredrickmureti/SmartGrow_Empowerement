---
name: Hardware Platform — Post Wave 9d
description: Canonical device registry, single chokepoint, driver-ownership rule, runtime capability probe, and consumer rules for any new hardware code path
type: feature
---

**Single source of truth:** `public.device_assignments` (org-scoped via `user_roles` RLS). Always read/write through `useDeviceAssignments` from `@/hooks/useDeviceAssignments`. Cross-module consumers (Inventory, Warehouse, HR, Manufacturing) use `useDeviceForRole(role, scope?)` from `@/hooks/useDeviceForRole`. The legacy `pos_hardware_configs` mirror was dropped in Wave 9b — never reintroduce.

**Single chokepoint:** Every hardware call goes through `hardwareClient` from `src/services/hardware/HardwareClient.ts`. Guard: `src/test/architecture/hardware-single-chokepoint.test.ts`. No `src/` file may touch `window.pos.usb|serial|hid` directly outside the allow-list.

**Platform surface:** Hardware lives at `/platform/hardware/devices` and `/platform/hardware/diagnostics` (mounted in `src/App.tsx`; legacy `/pos/hardware-*` URLs redirect via `<Navigate>`). Components and hooks live under `*/hardware/`, never `*/pos/`. Guard: `hardware-not-pos-scoped.test.ts`.

**Operator workspace (ADR-0100):** `/platform/hardware/print-queue` and `/platform/hardware/diagnostics` are operator surfaces. Primary tables show business identity (document number, requester name, printer name, human status) — never raw UUIDs or enums. All enum text goes through `src/apps/platform/hardware/lib/humanize.ts` (`docTypeLabel`, `intentLabel`, `formatLabel`, `transportLabel`, `statusLabel`, `runtimeReasonLabel`, `classifyError`). Business identity is resolved via the batched hooks in `src/apps/platform/hardware/hooks/useHardwareDisplay.ts` (`useDocumentDisplay`, `useRequesterDisplay`, `usePrinterDisplay`). Technical fields (correlation id, hw_command_id, raw error, timeline) live inside `components/JobDetailDrawer.tsx` or behind the "Support engineer view" toggle. Diagnostics is a tabbed workspace (Overview · Devices & health · Activity · Errors & DLQ · Runtime · Support), URL-synced via `?tab=`. Support-only utilities (Copy diagnostics JSON, support bundle) live under the Support tab. Guard: `hardware-operator-workspace-humanized.test.ts`. New print `doc_type` / transport / intent enums MUST be added to `humanize.ts` in the same PR.

**Driver-ownership rule (Wave 9d):** Main-process drivers in `electron/hardware/drivers/` are authoritative for every transport-backed role. Renderer drivers in `src/services/hardware/drivers/` are browser fallback only and must be registered with `{ browserFallback: true }`. Scanners (`keyboard_scanner`, `hid_scanner`) and `BrowserPrintDriver` are the only renderer-primary drivers (no main equivalent). Guard: `hardware-driver-duplication.test.ts` (pending inversion in Wave 9d.2).

**Runtime capability probe:** `hardwareClient.runtimeCapability()` returns `{ runtime, platform, preloadBuild, transports, ops, warnings }` — single authoritative answer for "what can this runtime actually do?". Cached 5s; invalidate via `invalidateRuntimeCapability()` after agent reconnect or transport failure. Electron branch asks the preload (`window.pos.hardware.capabilities()` → main `pos:hardware:capabilities` handler, lazy-imports each transport module, never opens devices). Browser branch feature-detects `'usb'|'serial'|'hid' in navigator`. IoT-agent branch maps `/healthz` into the same shape. The Runtime card on `/platform/hardware/devices` renders this — no static "browser mode" copy allowed.

**Electron cache:** SQLite assignments table is a *cache*. `<ElectronHydratorMount />` in `src/App.tsx` syncs canonical rows into it via `window.pos.devices.upsert`.

**Runtime-reason logging:** `HardwareClient.execAny` records one of `electron-bypass`, `browser-direct`, `electron-fallback-unexpected` per call into a 50-entry ring buffer exposed via `getRecentRuntimeReasons()`. An `electron-fallback-unexpected` emits `console.warn` and indicates a stale preload bundle.

**Authoritative docs:** `docs/architecture/HARDWARE_RUNTIME.md` (runtime + flow) and `docs/architecture/HARDWARE_CAPABILITY_MATRIX.md` (transport/op matrix). If code disagrees with the doc, fix the code.

**How to apply:**
- New hardware UI → `useDeviceAssignments({ scope })` or `useDeviceForRole(role, scope?)`.
- New hardware command → `hardwareClient.exec({ role, op, payload, idempotencyKey })`.
- New device support → main-process driver in `electron/hardware/drivers/` first; renderer driver, if any, forwards `exec` through `hardwareClient` and must not open transports directly.
- Never query `pos_hardware_configs` (dropped). Never import from `@/components/pos/DeviceRegistry*` or `@/hooks/pos/useHardwareProxy` (relocated). Never touch `window.pos.{usb,serial,hid}` from a UI file.
- Add a new (role, op) → update `HARDWARE_CAPABILITY_MATRIX.md` in the same PR.
- Add a new print `doc_type` / `intent` / `format` / `transport` / `RuntimeReason` → add the label to `src/apps/platform/hardware/lib/humanize.ts` in the same PR (guarded).
- Add a new operator signal on `/platform/hardware/diagnostics` → put it inside an existing tab (or add a new tab). Never grow another top-level card on the page.

## Print acknowledgement (Phase 5)

UI surfaces never await the printer. They call
`acknowledgeRecordPrint` / `acknowledgeSourcePrint`
(`src/services/printing/acknowledge.ts`) or `usePrintDispatch`, which are
released the moment the `print_jobs` rows are durable ("Print queued"),
and report only terminal failures later. `printDocumentIntent` /
`printSourceDocumentIntent` stay for background jobs and tests. Guardrail:
`src/test/printing/non-blocking-surfaces.test.ts`. The non-page dispatchers
(GRN, HR letters, vendor statements, POS receipt reprints, payslips) also
return at the enqueue, never at the printer.

## Print job terminal semantics (Phase 5.4/5.5)

- Paper output (PDF) is terminal at **host handoff**: `toPage` fires
  `onHandedToHost` when `window.print()` / the Electron main process takes the
  bytes, and the ledger settles there — never when the operator dismisses the
  OS dialog.
- A `sent` row on a host-dialog transport (`pdf-browser`, `pdf-electron`,
  `download`, `virtual`) or with `disposition = 'download'` is **stranded**:
  the recovery sweeper closes it as `abandoned` via `print_jobs_strand`
  instead of reprinting it. Only device (`thermal`) and `queued` rows are
  replayed. Guardrail: `src/test/printing/pdf-handoff-and-strand.test.ts`.

