# Audit — Hardware Phase 2 (single registry), 2026-05-21

## Scope
Phase 2 of the hardware platform plan (`.lovable/plan.md`): collapse the
dual registries (Supabase `pos_hardware_configs` + Electron SQLite
`pos_device_assignments`) into a single source of truth.

## What shipped

### Database (migration applied)
- New table `public.device_assignments` (platform-scoped: organization +
  optional business + scope_kind/scope_id). Columns: role, transport,
  driver, display_name, config jsonb, capabilities jsonb, enabled,
  is_default, status, last_seen_at, last_error, source_config_id,
  timestamps, created_by.
- Indexes: `device_assignments_org_role_idx` (partial WHERE enabled),
  `device_assignments_scope_idx`, plus the UNIQUE on `source_config_id`
  needed for the mirror trigger's ON CONFLICT.
- RLS: SELECT/INSERT/UPDATE/DELETE all gated on
  `organization_id IN (SELECT organization_id FROM user_roles WHERE user_id = auth.uid())`
  — matches the existing `pos_hardware_configs` pattern.
- Trigger `pos_hw_config_mirror` on `pos_hardware_configs` →
  `mirror_pos_hw_config_to_device_assignments()` (SECURITY DEFINER,
  search_path locked) keeps both tables in sync transparently.
- Backfill: every existing `pos_hardware_configs` row now has a matching
  `device_assignments` row linked via `source_config_id`.

### Client
- `src/hooks/useDeviceAssignments.ts` — new hook with scoped read, realtime
  subscription, upsert and remove mutations. Drop-in replacement target for
  `useDeviceRegistry`.
- `src/services/hardware/ElectronAssignmentHydrator.ts` — pulls
  `device_assignments` for the current org and pushes each enabled row into
  the Electron SQLite cache via `window.pos.devices.upsert`. Subscribes to
  realtime so DeviceManager always boots against the latest binding.
  No-ops outside Electron.
- `src/components/hardware/ElectronHydratorMount.tsx` — passive mount
  point. Not yet wired into `__root.tsx`; mount it once near the org
  provider when promoting Phase 2 to default.

### Not yet shipped this turn (deferred to a follow-up)
- Mounting `<ElectronHydratorMount />` in `__root.tsx` (intentionally held
  back — wants to be enabled only after the hydrator has been smoke-tested
  on a stale-cache scenario).
- Replacing the `useDeviceRegistry` body with a shim over
  `useDeviceAssignments`. The hook is still in use; the mirror trigger
  makes the migration safe without this change.
- The "Migration status" row on `/pos/hardware-diagnostics` (Supabase row
  count vs SQLite cache count). The data path now exists
  (`getHydratorStatus()`); the UI row is a small follow-up.
- ESLint rule extension and dedicated RLS test SQL.

## Verification
- Migration applied cleanly. The 1547 linter warnings reported are
  pre-existing (the two new functions both pin `search_path`); no new
  ERROR-level findings attributable to this migration.
- Build passes (TypeScript). One narrow `as any` cast is used to bridge
  the generated `Json` type on jsonb upsert payloads — same approach the
  existing hardware hook uses for `connection_params`.

## Rollback
Single-step: `DROP TRIGGER pos_hw_config_mirror ON pos_hardware_configs;`
followed by `DROP TABLE public.device_assignments CASCADE;`. The legacy
`pos_hardware_configs` table is untouched and remains the operational
source for the legacy UI until the hook swap lands.
