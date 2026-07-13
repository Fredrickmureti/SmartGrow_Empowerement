# Platform Administration UX Re-architecture

## 1. Problem, in one line

Platform Admin (`/admin-management/*`) is dialog-and-sheet driven: `AdminOrganizations` opens 5 modal dialogs (Details, Manage Subscription, Suspend, Multi-Step Delete, Schedule Deletion), `AdminUsers` opens Details + Delete dialogs, `AdminTeam` and `AdminGroups` create/edit inside `DialogContent`, `AdminLocalizationPacks` edits a full pack in a 1100px Sheet, `AdminEmailCenter` composes campaigns and templates in dialogs. Meanwhile tenant modules (Sales invoice create, HR department create, Contact create, Purchase order edit) all use dedicated route workspaces built on `@/design-system` primitives (`RecordShell`, `RecordFormShell`, `WizardShell`, `DetailSheet` peeks). The two halves of the ERP feel like different products.

## 2. First principles: interaction classification

Every Platform Admin business event gets classified into exactly one of four patterns. This becomes the rule going forward — no new dialog-driven CRUD accepted.

| Pattern | When to use | Primitive |
|---|---|---|
| **Workspace page** (`/admin-management/…/{new,$id,$id/edit}`) | Multi-section entity with lifecycle, relationships, or repeated visits | `RecordShell` + `RecordFormShell` (`mode="create" \| "edit"`) |
| **Wizard** (own route) | Ordered, gated, multi-step process with a commit at the end | `WizardShell` + `WizardStepper` |
| **Peek sheet** (`?peek=<id>`) | Read-mostly quick look with 1–2 quick actions and an "Open full page" link | `DocumentPeekShell` |
| **Confirm dialog** | Single-question destructive/irreversible confirmation, no form fields beyond a typed confirmation token | `AlertDialog` |

Inline edits (a single field on a row) may stay inline. Everything else moves.

## 3. Event → pattern map (the actual decisions)

Organizations
- Create / Edit Organization → **workspace** `/admin-management/organizations/new`, `/…/$id/edit` (replaces inline create + `OrganizationDetailsDialog` for editing)
- Manage Subscription → **workspace** `/…/$id/subscription` (plan, entitlements, overrides, payment history in tabs; replaces `ManageSubscriptionDialog` + `OrgEntitlementOverrides` modal)
- Suspend Organization → **confirm dialog** (short reason + confirm) — keep
- Multi-Step Delete → **wizard route** `/…/$id/delete` (impact review → data export → typed confirm) — this is a workflow, not a modal
- Schedule Deletion → **confirm dialog** with date — keep
- Ownership Transfer → **peek sheet** action → confirm dialog

Users
- User Details → already have `AdminOrganizationDetail`-style page; make `/admin-management/users/$id` the canonical detail workspace; keep `?peek=$id` on the list via `DocumentPeekShell`
- Delete User → **confirm dialog** — keep

Team & Groups (platform staff RBAC)
- Invite Member → **workspace** `/admin-management/team/invite` (role, groups, scopes)
- Edit Member → **workspace** `/…/team/$id/edit`
- Create/Edit Group → **workspace** `/admin-management/groups/new`, `/…/groups/$id/edit` (name + permissions matrix is not a dialog job)
- Delete → **confirm dialog**

Localization
- Create/Edit Pack → **workspace** `/admin-management/localization-packs/new`, `/…/$id/edit` (already have `AdminLocalizationCertificateEdit` page — extend pattern to packs; drop the 1100px Sheet)
- Publish Pack Version → **wizard** `/…/$id/publish` (diff → validation → publish)
- Install Pack on tenant → **wizard** in Organizations workspace

Plan Builder & App Catalog
- Create/Edit Plan → **workspace** `/admin-management/plan-builder/new`, `/…/$id/edit` (features, entitlements, app access, pricing tabs)
- Create/Edit App entry → **workspace** `/…/app-catalog/$id/edit`
- Feature Catalog entry → **peek** for read, **workspace** for edit

Email Center
- Compose Campaign / New Campaign → **workspace** `/…/email-center/campaigns/new` (audience, template, schedule)
- Edit Template → **workspace** `/…/email-center/templates/$id/edit`
- Automation Settings → **workspace** `/…/email-center/automations/$id`

Demo Requests
- Request Details → **peek sheet** (read + status change)
- Compose reply → **workspace** (reuses email compose workspace with request pre-filled)

Infrastructure / Settings tabs
- Keep as configuration pages; provider connect flows (`IntegrationProviderManager`, Mpesa env) stay as inline forms — they are configuration, not entity CRUD.

## 4. Shared foundation to build first

Before migrating individual events, land the substrate so every subsequent migration is a small, mechanical change:

1. **`src/apps/platform-admin/`** — mirror `src/apps/platform/`: `PlatformAdminAppLayout` wrapping `PlatformShell` with `PLATFORM_ADMIN_NAV` derived from `src/lib/admin/registry.ts`. Retire `AdminDashboardLayout` + `AdminSidebar` so admin uses the same shell primitives as tenant apps.
2. **Admin record scaffolds** — thin re-exports (`AdminRecordPage`, `AdminRecordForm`, `AdminPeekShell`) around `RecordShell` / `RecordFormShell` / `DocumentPeekShell`, so admin pages import from one place and stay visually identical to tenant record pages.
3. **Route conventions** — every list route supports `?peek=<id>`; every entity has `/new`, `/$id`, `/$id/edit`; wizards live at `/$id/{action}`.
4. **Lint guard** — new eslint rule `no-dialog-crud-in-admin` flagging `DialogContent`/`SheetContent` inside `src/pages/admin/**` and `src/components/admin/**` that contains form inputs beyond a single confirmation field. Allowlist confirmation dialogs and inline settings dialogs.

## 5. Migration phases

Each phase ships end-to-end (routes registered in `App.tsx` + `src/routes/-lazyRoutes.tsx`, nav entries in the admin registry, old dialog file deleted or reduced to a confirm dialog, no dead imports).

- **Phase 0 — Foundation**: items in §4. No behavior change.
- **Phase 1 — Organizations**: highest-value surface, most dialogs. Workspaces for create/edit/subscription, wizard for delete, peek for row inspection. Delete `OrganizationDetailsDialog`, `ManageSubscriptionDialog`, `MultiStepDeleteDialog` (folded into wizard route).
- **Phase 2 — Users + Team + Groups**: workspaces for invite/edit/group management, peeks for row inspection, confirm dialogs only for destructive ops. Delete `UserDetailsDialog` (becomes peek), keep `DeleteUserDialog` as confirm.
- **Phase 3 — Plan Builder + App Catalog + Feature Catalog**: workspace routes with tabs.
- **Phase 4 — Localization Packs**: workspace + publish wizard, drop the 1100px Sheet.
- **Phase 5 — Email Center + Demo Requests**: workspaces for campaigns/templates/automations, peek for demo request row.
- **Phase 6 — Cleanup**: enable lint rule, delete leftover admin dialogs, docs entry under `docs/design-system/audit/platform-admin.md` documenting the interaction classification so future work stays consistent.

## 6. Non-goals

- No changes to tenant-facing modules (Sales, HR, etc.) — they already follow the pattern.
- No visual redesign of the admin shell beyond adopting `PlatformShell`.
- No changes to Supabase schema, RLS, or business logic. Route additions only wrap existing data hooks.
- Confirmation `AlertDialog` usages remain; only entity-form dialogs/sheets are in scope.

## 7. Technical notes

- Admin routes are still classic `react-router-dom` under `App.tsx` (`/admin-management` → `AdminLayoutRoute`), not TanStack file routes. New workspace/wizard/peek routes register as nested `<Route>` children there and lazy-load via `src/routes/-lazyRoutes.tsx`, matching the existing convention. No migration to `src/routes/` in this project.
- `PlatformShell` today is imported by tenant `PlatformAppLayout`; it is framework-agnostic and works fine inside the react-router admin subtree.
- `RecordShell`, `RecordFormShell`, `WizardShell`, `DocumentPeekShell`, `useRecordFormSubmit`, `usePeekParam` are already exported from `@/design-system` — no new primitives required.
- Command palette (`buildPlatformAdminEntries`) automatically picks up new admin routes once they are added to `src/lib/admin/registry.ts`.
- Each phase is independently shippable; behavior of unmigrated surfaces is unchanged until their phase.
