# ADR-0099: Hardware — single registration surface

## Status
Accepted — 2026-07-27.

## Context
Two parallel device-registration UIs had drifted apart while writing to the
same `public.device_assignments` table:

- `HardwareDevices` (`/platform/hardware/devices`) embedded
  `DeviceRegistryCard`, drove driver choices off the real
  `DriverRegistry.getDriversForRole(role)`, and had structured transport
  sub-forms plus browser-side discovery.
- `DeviceWizard` (`/platform/hardware/devices/new`) used a hardcoded
  `role → driver_type[]` map that included `zpl_label` / `epl_label` /
  `escpos_label` — none of which were registered in `DriverRegistry`. Rows
  saved from the wizard could not be resolved at dispatch time
  (`createDriver('zpl_label')` returned `null`).

Compounding the drift: `EscPosPrinterDriver.supportedRoles` claimed
`label_printer`, so on the mature page the "Label Printer" role legitimately
offered receipt-printer drivers. Neither surface was fully correct.

## Decision
1. **One registration surface**: `HardwareDevices` (with `DeviceRegistryCard`
   embedded). The `/devices/new` route redirects to it.
2. **One driver catalog**: `services/hardware/drivers/DriverRegistry`. All
   UIs render role/driver options via `getDriversForRole()`. Hardcoded
   `role → driver_type[]` tables in UI components are forbidden.
3. **Label printers are first-class drivers**: `zpl_label`, `epl_label`,
   `escpos_label` are registered renderer drivers (`browserFallback: true`,
   backed by the main-process drivers under
   `electron/hardware/drivers/`). `EscPosPrinterDriver` no longer claims
   the `label_printer` role.
4. **Persistence stays** on `public.device_assignments` via
   `useDeviceAssignments` — schema unchanged.

## Consequences
- Adding a new role or driver is a single-file change in
  `DriverRegistry.ts`; every UI picks it up automatically.
- The wizard's discovery ranking and structured transport fields are now
  provided by `DeviceRegistryCard` (browser-API discovery + typed transport
  sub-forms — no free-form JSON).
- Guarded by
  `src/test/architecture/hardware-registration-single-surface.test.ts`:
  the wizard file cannot return, `/devices/new` must remain a redirect,
  and UI files cannot hardcode `zpl_label`-style role→driver maps.
- Existing rows with legacy `driver_type='escpos'` on a `label_printer`
  role remain readable; operators reselect the driver on next edit. No
  data migration required.

## References
- ADR-0037 (browser-to-agent HTTPS relay).
- ADR-0087 (media geometry + printer capability as first-class admin
  surfaces).
- `.lovable/plan.md` — Hardware Platform Audit consolidation plan.