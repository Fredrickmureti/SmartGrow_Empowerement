# Hardware Subsystem — Legacy Mirror Trigger Drift RCA

**Date**: 2026-05-23
**Severity**: P0 — all device registration broken, both PWA and Electron
**Status**: Fixed (Phase A migration + Phase B pgTAP drift guard shipped)

## Symptom

`POST /rest/v1/device_assignments` returned `400 { code: '42703',
message: 'column "source_assignment_id" does not exist' }` on every
device registration attempt from the PWA. Same insert path from the
Electron renderer (via `ElectronAssignmentHydrator` / `HardwareDevices`
UI) failed identically.

## Root cause

The error was raised from **inside an AFTER trigger** on
`device_assignments`, not from the client payload. The renderer payload
is clean — the literal string `source_assignment_id` does not occur
anywhere in the `src/` tree.

Live database state at the time of the incident:

| Object | Expected (per migrations) | Actual |
|---|---|---|
| `public.pos_hardware_configs` table | dropped by Wave 9b (`20260521123034`) | **still present** |
| `pos_hardware_configs.source_assignment_id` column | added by Wave 5 (`20260521103216`) | **missing** |
| trigger `device_assignment_legacy_mirror` | dropped by Wave 9b | **still firing** |
| function `device_assignment_to_legacy_mirror()` | dropped by Wave 9b | **still present**, references the missing column 4× |

Two independent drifts:

1. **Wave 9b naming bug.** Wave 9b's `DROP TRIGGER` / `DROP FUNCTION`
   statements named `pos_hw_config_mirror` and
   `mirror_device_assignment_to_pos_hardware_configs`. The actual live
   objects were `device_assignment_legacy_mirror` and
   `device_assignment_to_legacy_mirror` (introduced by Wave 5). Wave 9b
   ran successfully and removed nothing.
2. **Schema drift outside migrations.** `pos_hardware_configs` survived
   `DROP TABLE … CASCADE` (either 9b never executed that statement on
   this project, or the table was restored manually). The
   `source_assignment_id` column from Wave 5 was never present on the
   surviving table.

Net effect: every INSERT into `device_assignments` fired the AFTER
trigger → the function ran `DELETE FROM pos_hardware_configs WHERE
source_assignment_id = …` → `42703` → transaction rollback → PWA and
Electron both saw a failed insert.

## Why existing guards did not catch it

`src/test/architecture/no-legacy-pos-hardware-configs.test.ts` only
scans `src/` for the legacy table name. It says nothing about the live
database. `useDeviceAssignments.ts` documents in a comment that "Wave
9b dropped the legacy `pos_hardware_configs` mirror" — that statement
was false in production for ~2 weeks.

## Fix

**Phase A** (migration `*_hardware_legacy_mirror_purge.sql`):

- Drops every known variant of the mirror trigger and function
  (`device_assignment_legacy_mirror` + `pos_hw_config_mirror` families).
- Guarded `DROP TABLE public.pos_hardware_configs CASCADE` — aborts
  with a row count if any legacy row is not represented in
  `device_assignments` so no data is silently lost.

**Phase B** (`supabase/tests/no_legacy_hardware_surface_test.sql`):

- pgTAP test that asserts the table is gone AND no trigger or function
  body references `pos_hardware_configs` / `source_assignment_id`. This
  is the live-DB counterpart of the existing `src/` arch-guard. If a
  future migration regrows either, this test fails immediately.

## Architectural verdict

The hardware subsystem is **not fragmented**. The renderer side
(`src/services/hardware/HardwareClient` as single public surface), the
main process side (`electron/hardware/DeviceManager` + `CommandRouter`
+ transports, Track 3b unified), the single source of truth
(`device_assignments` with `(scope_kind, scope_id)` scoping and
realtime sync), and the environment split (renderer = WebUSB/WebSerial,
main = native `node-usb`/`serialport`) are all sound and match
`HARDWARE_CAPABILITY_MATRIX.md` + ADR 0014.

The defect was one stuck mirror trigger from a half-completed
deprecation, not an architectural fault.

## Lessons / follow-ups (Phases C–E in `.lovable/plan.md`)

- An `src/` arch-guard is necessary but **not sufficient** — every
  legacy-surface guard needs a live-DB twin.
- Formalize the device lifecycle FSM (`discovered → registered → online
  → degraded → offline → revoked`) as an enum + check constraint.
- Add `priority smallint` for same-role failover routing.
- Single sanctioned Electron detector (`src/lib/runtime/isElectron.ts`)
  + eslint rule banning ad-hoc sniffs.
- USB `holdOpen` semantics on both Electron `UsbTransport` and PWA
  `BrowserHardwareAdapter` so connections are seamless, instant, and
  don't drop between commands.