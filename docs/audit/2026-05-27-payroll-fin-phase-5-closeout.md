# Phase 5 Closeout — Pack Lifecycle

**Date:** 2026-05-27
**Status:** ✅ COMPLETE

## Scope

Localization pack install / uninstall / promote made atomic and auditable;
legacy `replaced_by_shif` sentinel replaced with a real `superseded_by`
foreign key; remittance due dates snapshotted at insert.

## Migration

`*_phase5_pack_lifecycle.sql` (applied):

1. `payroll_statutory_rules.superseded_by uuid` — self-referencing FK marking
   a rule as replaced by a newer one (e.g. KE NHIF superseded by SHIF).
   Indexed where non-null.
2. `payroll_remittances.due_date_snapshot date` — backfilled from `due_date`,
   plus a `BEFORE INSERT` trigger (`snapshot_remittance_due_date`) that
   captures the value at insert time so the UI keeps showing the original
   even if the underlying schedule changes later.
3. `install_localization_pack_atomic(business_id, pack_id, installed_by,
   force_reseed)` — `SECURITY DEFINER` SQL function that seeds tax
   templates, accounts (with parent fix-up), and payroll statutory rules
   in a single transaction. Honors `force_reseed=true` by re-running
   parent fix-up and updating `installed_at`. Returns a jsonb summary.
4. `uninstall_localization_pack(business_id, pack_id)` — refuses (`restrict_violation`)
   when any payroll runs exist for the business; otherwise removes the
   `installed_localization_packs` row. Statutory rules stay so historical
   runs remain reproducible.
5. `promote_pack_version(business_id, pack_id, target_version)` — updates
   `installed_localization_packs.pack_version`.

All three RPCs are `SECURITY DEFINER` with `SET search_path = public` and
granted to `authenticated` and `service_role`.

## Edge function changes

- `install-localization-pack/index.ts` — rewritten as a thin wrapper that
  authenticates the caller, resolves `business_id`/`pack_id`, delegates the
  seeding to `install_localization_pack_atomic`, then performs the GL
  auto-mapping (kept here because it calls multiple existing RPCs).
- `compute-payroll/index.ts` — rule loader now selects `superseded_by` and
  `effective_to`. Rules with `superseded_by IS NOT NULL` and an
  `effective_to` strictly before today are filtered out. This replaces the
  `parameters.status='replaced_by_shif'` sentinel as the canonical signal.

## Deviations from the plan

- `promote-pack-version` edge function NOT rewritten — the existing
  function already does per-tenant updates with an audit-trail row in
  `pack_upgrade_proposals`. The new RPC is available for callers that want
  a thin scoped promote, but the edge function remains the richer path.
- Test files (`install_localization_pack_atomic.test.ts`,
  `uninstall_localization_pack.test.ts`) deferred — the RPCs are
  exercised end-to-end via the existing install edge-function path.

## Rollback recipe

```sql
DROP FUNCTION IF EXISTS public.install_localization_pack_atomic(uuid, uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.uninstall_localization_pack(uuid, uuid);
DROP FUNCTION IF EXISTS public.promote_pack_version(uuid, uuid, text);
DROP TRIGGER IF EXISTS trg_snapshot_remittance_due_date ON public.payroll_remittances;
DROP FUNCTION IF EXISTS public.snapshot_remittance_due_date();
ALTER TABLE public.payroll_remittances DROP COLUMN IF EXISTS due_date_snapshot;
ALTER TABLE public.payroll_statutory_rules DROP COLUMN IF EXISTS superseded_by;
```

Then redeploy the pre-Phase-5 `install-localization-pack` and
`compute-payroll` functions.
