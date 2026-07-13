## Verification of prior work

I audited the codebase against `docs/design-system/audit/platform-admin.md` and the previous agent's exit note. Findings:

- **Phase 0–6 substrate is real and in place.** `src/apps/platform-admin/` exports the admin scaffolds; `eslint-rules/no-dialog-crud-in-admin.js` is wired; the workspace/wizard/peek/confirm primitives from `@/design-system` are being consumed by the new pages under `src/pages/admin/{organizations,plan-builder,team,groups,localization,email-center,settings,demo-requests}/`.
- **Users peek is implemented** (`usePeekParam` in `AdminUsers.tsx`), **Organizations peek is not** — confirmed the doc requires it and only Users has it.
- **App Catalog** has only the list route; no `$id/edit` workspace. The list uses inline row Switches/Selects, which the doc permits for single-field edits, but there is no dedicated edit surface for multi-field editing when needed.
- **Feature Catalog** (`FeatureCatalogSettings.tsx`) has an edit workspace already (`AdminFeatureEditPage`) but no read-peek — doc requires peek for read.
- **Generic Email Templates preview** in `components/admin/email/EmailTemplatesTab.tsx` is still a `Dialog` (lint-clean, no form controls) — doc explicitly calls this out as deferred polish.
- **PlatformShell migration (item 5)** is untouched — admin pages still render inside `AdminDashboardLayout` via `PlatformAdminAppLayout`, not `PlatformShell` with a workspace `nav.ts`.

The prior agent's summary is accurate. I am picking up from that state.

## Scope of this plan

Close the four tactical four-pattern gaps so `platform-admin.md` is fully honored end-to-end. **Item 5 (admin console onto `PlatformShell` + workspace `nav.ts`) is intentionally not in this plan** — it is a Phase-7 structural migration touching every admin page and warrants its own scoped plan with a phased rollout. I will surface that plan immediately after this one lands.

### 1. Organizations row peek — `?peek=<id>` on `/admin-management/organizations`
- Add `OrganizationPeekSheet` under `src/components/admin/organizations/` built on `AdminPeekShell` (`DocumentPeekShell`), showing: name, plan, status badge, owner email, country, created date, user count, and quick actions "Open full workspace" (→ `/organizations/$id`) + "Manage subscription" (→ `/organizations/$id/subscription`).
- Wire `usePeekParam()` in `AdminOrganizations.tsx`, add a "Quick look" menu item above the existing "View details" action, and make the row click open the peek (double-click / "View full workspace" navigates).
- Data: reuse the row's already-loaded `OrganizationWithStats`; no new query needed for v1.

### 2. App Catalog edit workspace — `/admin-management/app-catalog/$id/edit`
- Create `src/pages/admin/app-catalog/AdminAppCatalogEditPage.tsx` on `AdminRecordForm` (`mode="edit"`) with fields: name, description, category, required_plan, sort_order, is_available, is_visible_in_signup, is_core, icon override.
- Keep the current inline row toggles for the three boolean quick-switches (doc allows inline single-field edits) but replace the row's chevron/name click with a route to the edit workspace so multi-field edits use the workspace.
- Register the lazy route in `src/routes/-lazyRoutes.tsx` and mount under `/admin-management/app-catalog/:id/edit` in `App.tsx`.

### 3. Feature Catalog read peek
- Add `?featurePeek=<id>` param handling to `FeatureCatalogSettings.tsx` (uses its own key to avoid collision with any parent list peek).
- Add `FeaturePeekSheet` on `AdminPeekShell` showing: code, label, description, category, plan tier availability matrix, in-use count. Quick actions: "Edit feature" (→ existing `/plan-builder/features/$id/edit`).

### 4. Generic Email Templates preview → peek
- Convert the `Dialog` in `components/admin/email/EmailTemplatesTab.tsx` to `AdminPeekShell` driven by `?templatePreview=<id>` so preview is shareable and consistent with the other admin peeks.
- Keep the "Preview" and "Edit HTML" mode toggle inside the peek body; keep existing "Use template" / "Edit" actions in the peek's action bar.

### Non-goals (this plan)

- No changes to any tenant module.
- No visual redesign of the admin shell — that is item 5, a follow-up plan.
- No schema, RLS, or edge function changes.
- No changes to inline settings toggles already carrying `ADMIN-DIALOG-EXEMPT`.

### Verification per item

For each of 1–4: (a) `bun run build:dev` clean, (b) `bun run lint` clean including `no-dialog-crud-in-admin`, (c) Playwright smoke — open the list page, trigger the new peek/workspace, confirm no console errors and the retired dialog no longer renders.

### Deliverables

- New files: `OrganizationPeekSheet.tsx`, `AdminAppCatalogEditPage.tsx`, `FeaturePeekSheet.tsx`.
- Edits: `AdminOrganizations.tsx`, `AdminAppCatalog.tsx`, `FeatureCatalogSettings.tsx`, `EmailTemplatesTab.tsx`, `App.tsx`, `src/routes/-lazyRoutes.tsx`.
- Doc update: mark items 1–4 done in `platform-admin.md`; add a "Deferred → Phase 7" pointer for the `PlatformShell` migration.

### Follow-up (separate plan, after this ships)

Phase 7 — migrate `/admin-management/*` off `AdminDashboardLayout` onto `PlatformShell` + a workspace `nav.ts` per `docs/design-system.md`. That is the structural work that closes the "admin feels like a separate product" gap in the original brief. It will be planned page-group by page-group (Organizations & Users → Plans/Apps/Features → Localization → Email/Demo/Team/Groups → Settings/Infra/Audit) so each phase is independently shippable.
