# App lifecycle: retiring a module cleanly

When an app is removed from the strategic roadmap, decommission it across every layer in the order below. Skipping a step leaves orphaned infrastructure, stale RBAC rows, or invisible billing/plan wiring.

## Retirement checklist

1. **Frontend registry** (`src/lib/apps/registry.ts`)
   - Remove the `AppDefinition` export and the entry from `APP_REGISTRY`.
   - Remove from `src/apps/index.ts` exports.

2. **Module-to-app map** (`src/lib/apps/module-app-map.ts`)
   - If a `PermissionModule` was only mapped to the retired app, set the value to `[]` and add a `// retired YYYY-MM-DD` marker. Do **not** delete the key — it must stay to satisfy the enum.

3. **Marketing / features catalog** (`src/lib/apps/app-features.ts`)
   - Remove the block; leave a one-line `// retired` marker.

4. **Command palette** (`src/lib/admin/registry.ts`, `src/lib/command/`)
   - Drop any entry pointing at retired admin pages.

5. **Database catalog**
   - `DELETE FROM plan_app_access WHERE app_id = '<id>';`
   - `DELETE FROM platform_apps WHERE id = '<id>';`
   - `DELETE FROM organization_installed_apps WHERE app_id = '<id>';`
   - `DELETE FROM app_dependencies WHERE app_id = '<id>' OR depends_on_app_id = '<id>';`
   - `DELETE FROM app_included_features WHERE app_id = '<id>';`

6. **Domain tables, functions, triggers, views**
   - Verify each is empty (`SELECT count(*)`).
   - `DROP TABLE ... CASCADE` only after the count is zero or data is archived.
   - Drop standalone helper functions left over after cascade.

7. **Storage buckets**
   - `SELECT count(*) FROM storage.objects WHERE bucket_id = '<bucket>';`
   - If empty, delete objects + bucket. If non-empty, archive first.

8. **Edge functions / cron / pg_net**
   - List the `supabase/functions/` directory.
   - Delete app-specific functions via `supabase--delete_edge_functions`.
   - Drop any `cron.schedule` rows that targeted them.

9. **Tests**
   - Add the retired id to `src/test/architecture/no-retired-apps.test.ts`'s `RETIRED_APP_IDS` array.

10. **Docs**
    - Add an ADR entry under `docs/adr/` describing why the app was retired.

## Retired apps log

| ID             | Retired on  | Notes                                                          |
| -------------- | ----------- | -------------------------------------------------------------- |
| `recruitment`  | 2026-05-09  | HR sub-app folded back into Employees.                         |
| `sign`         | 2026-05-09  | E-Sign module retired; storage bucket `sign-documents` archive pending. |
| `spreadsheets` | 2026-05-09  | Replaced by Reports + BI surface.                              |
| `documents`    | 2026-05-09  | Shared `document_templates`/`document_emails` infra retained.  |
