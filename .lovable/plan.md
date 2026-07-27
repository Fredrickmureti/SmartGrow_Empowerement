# Hardware Platform Audit — Device Registration Consolidation

## 1. Findings (evidence-based)

### 1.1 Two UIs, one persistence layer
Route table (`src/apps/platform/hardware/routes.tsx`):
- `/platform/hardware/devices` → `HardwareDevices.tsx` → embeds `<DeviceRegistryCard/>` (Register tab) + Assignments/Discover/Runtime tabs.
- `/platform/hardware/devices/new` → `DeviceWizard.tsx`.

Both writers eventually persist to the **same table** `public.device_assignments`:
- `DeviceRegistryCard` writes via `useHardwareRegistryCrud` → `supabase.from("device_assignments").insert/update` (`src/hooks/hardware/useHardwareRegistryCrud.ts:188,224,242,268`).
- `DeviceWizard` writes via `useDeviceAssignments().upsert` → same table (`src/hooks/useDeviceAssignments.ts`).

So the divergence is **UI + driver catalog**, not database. This is Option D from the brief: a partial rewrite that never finished — the wizard was added as the "missing surface between discovery classifier and a saved assignment row" (see `DeviceWizard.tsx:12-19`), but the mature page (`HardwareDevices`) was never retired and the two catalogs drifted.

### 1.2 Root cause of the "Label Printer → ESC/POS" bug
`DeviceRegistryCard` renders drivers from the real registry via `getDriversForRole(role)` (`DriverRegistry.ts:73`). The registry (`DriverRegistry.ts:143-181`) registers **no label-specific drivers**. Instead `EscPosPrinterDriver.supportedRoles` includes `label_printer` (`EscPosPrinterDriver.ts:21`), so selecting Label Printer legitimately returns `escpos/star/epson/citizen/bixolon` — none appropriate for ZPL/EPL thermal label printers.

`DeviceWizard` avoids the registry entirely and uses a hardcoded map `label_printer: ["zpl_label","epl_label","escpos_label"]` (`DeviceWizard.tsx:81-90`). These driver types are **not registered** in `DriverRegistry` — so a device saved from the wizard cannot be dispatched to at runtime (`createDriver('zpl_label')` returns null). The wizard's UX is correct; its plumbing is a dead end.

Conclusion: **neither surface is fully correct**. The wizard has the right UX shape but no drivers behind it; the mature page has the right runtime plumbing but a mis-declared driver→role table.

### 1.3 Ownership map (canonical, after consolidation)

| Concern | Owner |
|---|---|
| Persistence | `public.device_assignments` (single tenant-scoped registry) |
| CRUD hook | `useDeviceAssignments` |
| Driver + backend catalog | `services/hardware/drivers/DriverRegistry` (`getDriversForRole`, `getBackendsForDriver`) |
| Role vocabulary | `services/hardware/drivers/DriverInterface.DeviceRole` |
| Discovery + classification | `electron/hardware/discovery/*` → `window.pos.hardware.discover()` |
| Runtime dispatch | `hardwareClient.exec` → CommandRouter → DeviceManager → Transport |
| Assignments view | `HardwareDevices.tsx` (Assignments / Runtime / Discover tabs) |
| Test dispatch | `printClient.printLabel` for labels; `hardwareClient.exec` for everything else |

### 1.4 Enterprise-pattern reference
Mature POS/ERP hardware stacks (Odoo IoT, Shopify POS, Square, Lightspeed, Toast, MS Dynamics 365 Commerce, Zebra Setup Utilities, Epson TM Utility) converge on the same shape:

1. **One device registry**, keyed by (org, branch/register, role, transport-identity).
2. **Role → capability profile → compatible drivers**. Drivers declare which roles they support; the UI never hardcodes lists.
3. **Discovery is optional**; a single register flow supports both "scan & bind" and "add manually", not two separate pages.
4. **Config is structured** (transport + typed params), never free-form JSON pasted by an operator.
5. **Lifecycle is orthogonal to registration**: assignment, runtime status, diagnostics, retirement are separate views over the same row.

Our target end-state matches this pattern.

## 2. Consolidation strategy

Keep `/platform/hardware/devices` as the **single** authoritative surface. Fold the wizard's genuinely-additive capabilities (discovery classifier ranking, structured transport-param derivation) into it. Delete the `/devices/new` route. No compatibility layer, no fallback page.

## 3. Migration plan (staged, no regressions)

### Step A — Fix the driver catalog (root cause of the reported bug)
1. Remove `label_printer` from `EscPosPrinterDriver.supportedRoles`.
2. Add real label drivers: `ZplLabelDriver`, `EplLabelDriver`, `EscPosLabelDriver` (thin classes reusing existing transport plumbing; wired as `supportedRoles = ['label_printer']`). Register them in `DriverRegistry`.
3. Result: `getDriversForRole('label_printer')` returns `zpl_label / epl_label / escpos_label` in **both** UIs automatically.
4. Guard: extend `src/test/architecture/role-vocabulary.test.ts` (or add a sibling) asserting every `DeviceRole` has ≥1 registered driver, and that `receipt_printer` drivers do not claim `label_printer`.

### Step B — Promote DeviceRegistryCard to full-featured register flow
Inside `HardwareDevices.tsx` Register tab (`DeviceRegistryCard`):
1. Add a "Discover" affordance that calls `window.pos.hardware.discover()` and renders the wizard's ranked candidate list; picking a candidate pre-fills role, driver, transport, and structured params.
2. Replace all free-form JSON entry with typed sub-forms per transport (`usb: vendorId/productId`, `network: host/port`, `serial: path/baudRate`, `cups/winspool: queueName`). No `<textarea>` for config anywhere.
3. Keep manual-add as the fallback path when discovery isn't available (browser/PWA) — one form, two entry points, one code path.

### Step C — Retire `/platform/hardware/devices/new`
1. Delete `src/apps/platform/hardware/DeviceWizard.tsx`.
2. Remove the `devices/new` route from `routes.tsx`; add a `Navigate` redirect from `devices/new` → `devices?tab=register` for any bookmarked links, then remove after one release.
3. Delete the wizard's private `ROLE_OPTIONS` / `DRIVER_OPTIONS` / `TRANSPORT_OPTIONS` constants — `DriverRegistry` is the only source of truth.
4. Delete tests that pin the old wizard URL; update `platform-hardware-has-editor.test.ts` if needed.

### Step D — Architecture guards (prevent re-drift)
1. New test `src/test/architecture/hardware-single-registration-surface.test.ts`:
   - Asserts only one route path matches `/platform/hardware/devices/*` renders a registration form.
   - Asserts no file outside `DriverRegistry.ts` hardcodes `role → driver[]` maps (regex on `label_printer.*zpl_label` etc.).
   - Asserts no `<textarea>` labelled "Config (JSON)" exists in `src/apps/platform/hardware/**`.
2. New test asserting every writer to `device_assignments` goes through `useDeviceAssignments` (grep guard).

### Step E — Docs & ADR
Add `docs/adr/00XX-hardware-single-registration-surface.md` recording: one registry table, one CRUD hook, one register page, driver catalog is authoritative, discovery is a mode not a page.

## 4. Non-goals (explicitly)
- No change to `device_assignments` schema.
- No change to CommandRouter / transports / `hardwareClient` runtime.
- No change to Assignments/Runtime/Diagnostics tabs beyond what Step B needs.

## 5. Deliverables checklist (from the brief)

1. Duplicate registration systems exist? **Yes — UI-only, shared table.** §1.1
2. Canonical ownership → §1.3.
3. Device registration architecture → §1.3 + Step B.
4. Driver resolution → `DriverRegistry.getDriversForRole` after Step A.
5. Capability discovery → `electron/hardware/discovery` classifier, surfaced in-page by Step B.
6. Runtime ownership → `hardwareClient` (unchanged).
7. Assignment ownership → `useDeviceAssignments` on `device_assignments`.
8. Database ownership → `device_assignments` (single table).
9. UI ownership → `HardwareDevices.tsx` (single page, tabbed).
10. Consolidation strategy → §2.
11. Migration plan → §3, staged A→E, no regressions.

## 6. Risk & rollback
- Step A is behavior-changing for existing label-printer rows saved with `driver_type='escpos'`: add a one-shot migration/hook that rewrites those rows to `escpos_label` on first read, or surfaces a "driver deprecated — reselect" chip. Rollback = revert the driver-registry commit; DB shape unchanged.
- Step C removes a route: 302 redirect covers bookmarks.

## 7. Execution order
A (driver catalog + guard) → B (promote register flow) → C (delete wizard + route) → D (guards) → E (ADR). Each step ships independently; the reported bug is fixed at end of Step A.
