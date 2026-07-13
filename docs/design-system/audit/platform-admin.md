# Platform Administration — Interaction Classification

Status: **normative** as of this document. Any new work under
`/admin-management/*` must classify each business event into one of the
four patterns below and use the matching primitive from
`@/design-system`. Reviewers reject PRs that introduce a new form-bearing
`DialogContent` or `SheetContent` in `src/pages/admin/**` or
`src/components/admin/**` unless it is a single-question confirmation.

## Why

Tenant modules (Sales, HR, Purchases, Inventory, Finance) do their real
work in dedicated route workspaces (`RecordShell` / `RecordFormShell` /
`WizardShell`) with `DetailSheet`/`DocumentPeekShell` used only for
read-mostly peeks. Platform Admin historically shipped CRUD in dialogs
and 1100px side sheets, producing an ERP whose "back office" felt like a
different product from its tenant modules. This document is the
rulebook that closes that gap.

## The four patterns

| Pattern | When | Route | Primitive |
|---|---|---|---|
| **Workspace page** | Multi-section entity with lifecycle, relationships, or repeated visits | `/admin-management/<area>/{new,$id,$id/edit,$id/<sub>}` | `RecordShell` + `RecordFormShell` (`mode="create" \| "edit"`) |
| **Wizard** | Ordered, gated, multi-step process with a commit at the end | `/admin-management/<area>/$id/<action>` | `WizardShell` + `WizardStepper` |
| **Peek sheet** | Read-mostly quick look with 1–2 quick actions and an "Open full page" link | `?peek=<id>` query param on the list route | `DocumentPeekShell` |
| **Confirm dialog** | Single question, no form fields beyond a typed confirmation token | inline on the list / detail page | `AlertDialog` |

Inline single-field edits on a row (rename, toggle) remain inline.
Anything larger classifies into one of the four patterns above.

## Event → pattern map

Organizations (`/admin-management/organizations`)
- Create Organization — **workspace** `/organizations/new`
- Edit Organization — **workspace** `/organizations/$id/edit`
- View Organization — **workspace** `/organizations/$id` (already exists)
- Row inspection — **peek** `?peek=$id`
- Manage Subscription — **workspace** `/organizations/$id/subscription`
- Suspend — **confirm dialog** (reason + confirm)
- Multi-step Delete — **wizard** `/organizations/$id/delete`
- Schedule Deletion — **confirm dialog** (date + confirm)
- Ownership Transfer — **confirm dialog** launched from workspace
- Add / Edit Entitlement Override — **workspace** `/organizations/$id/entitlements/{new,$overrideId/edit}`
- Remove Entitlement Override — **confirm dialog**

Users (`/admin-management/users`)
- View User — **workspace** `/users/$id`
- Row inspection — **peek** `?peek=$id`
- Delete — **confirm dialog**

Team & Groups
- Invite Member — **workspace** `/team/invite`
- Edit Member — **workspace** `/team/$id/edit`
- Create Group — **workspace** `/groups/new`
- Edit Group (name + permissions matrix) — **workspace** `/groups/$id/edit`
- Delete — **confirm dialog**

Localization
- Create/Edit Pack — **workspace** `/localization-packs/new`, `/…/$id/edit`
- Publish Pack Version — **wizard** `/localization-packs/$id/publish`
- Install Pack on tenant — **wizard** from an Organization workspace

Plan Builder & App Catalog
- Create/Edit Plan — **workspace** `/plan-builder/new`, `/…/$id/edit`
- Create/Edit App entry — **workspace** `/app-catalog/$id/edit`
- Feature Catalog — **peek** for read, **workspace** for edit

Email Center
- New Campaign — **workspace** `/email-center/campaigns/new`
- Edit Template — **workspace** `/email-center/templates/$id/edit`
- Automation Settings — **workspace** `/email-center/automations/$id`

Demo Requests
- Request Details — **peek**
- Compose reply — **workspace** (reuses email compose workspace)

Auth Email Templates (Settings)
- Preview / HTML code viewer — **peek** (`?authEmailPeek=<id>&authEmailMode=preview|code`)

Demo Video Library (Settings)
- Add / Edit Video — **workspace** `/admin-management/settings/demo-videos/{new,$id/edit}`
- Delete — **confirm dialog**

Infrastructure / Settings tabs
- Provider connections and toggles remain inline configuration forms.
  They are not entity CRUD; the four-pattern rule does not apply. Files
  in this exemption may carry `// ADMIN-DIALOG-EXEMPT: <reason>` on any
  overlay the four-pattern rule would otherwise flag.

## The substrate

Every admin migration composes from these:

```ts
import {
  RecordShell,
  RecordFormShell,
  WizardShell,
  DocumentPeekShell,
  usePeekParam,
  useRecordFormSubmit,
} from "@/design-system";

// Convenience re-exports scoped to admin:
import {
  PlatformAdminAppLayout,
  AdminRecordPage,
  AdminRecordForm,
  AdminPeekShell,
} from "@/apps/platform-admin";
```

`PlatformAdminAppLayout` wraps the shared admin shell so new pages that
opt in inherit the same chrome as the rest of the console. Existing
pages continue to render inside `AdminLayoutRoute` unchanged during the
migration.

## Migration checklist (per event)

1. Classify the event (workspace / wizard / peek / confirm).
2. Add the route to `App.tsx` under `/admin-management` and register it
   in `src/routes/-lazyRoutes.tsx`.
3. Add a nav / command entry in `src/lib/admin/registry.ts` if
   top-level; the command palette picks it up automatically.
4. Build the page from the admin scaffolds above.
5. Remove the retired `Dialog`/`Sheet` component and every state hook
   (`useState`, handler, JSX slot) that opened it from the list page.
6. Verify: dev build clean, no dead imports, list page still functions
   (row click / action menu now routes instead of opening a dialog).

## Migration order

Phase-by-phase, each phase is independently shippable.

- **Phase 0** — substrate (this doc + `@/apps/platform-admin`).
- **Phase 1** — Organizations (Create, Edit, Manage Subscription
  workspace; Multi-step Delete wizard; row peek).
- **Phase 2** — Users, Team, Groups (workspaces for
  invite/edit/group-permissions, peek for user row).
- **Phase 3** — Plan Builder, App Catalog, Feature Catalog workspaces.
- **Phase 4** — Localization Packs workspace + publish wizard.
- **Phase 5** — Email Center + Demo Requests workspaces.
- **Phase 5.5** — Entitlement Overrides, Demo Video Library, Auth Email
  Template viewers migrated to workspaces / peek sheets. Publish Pack
  Version wizard shipped (`/localization-packs/$id/publish`).
  Install-Pack-on-tenant wizard shipped
  (`/admin-management/organizations/$id/localization/install`),
  entered from the Localization tab on the org workspace; the
  `install-localization-pack` edge function accepts platform-admin
  on-behalf-of callers.
  Confirm-shape overlays (SuspendOrganization, ScheduleDeletion,
  DeleteUser, OwnershipTransfer) converted from `Dialog` to
  `AlertDialog` so they classify as the confirm-dialog pattern.
- **Phase 6** — Lint guard `local/no-dialog-crud-in-admin` scoped to
  `src/{pages,components}/admin/**` at error level, **enforced**
  (all custom ESLint rules converted to ESM `export default` so the
  flat config loads cleanly). New form-bearing Dialog/Sheet in those
  trees fails the lint step. Overlays that are legitimately inline
  (settings tabs, provider connections, MFA setup, bank/mpesa/
  exchange-rate/AI/data-reset/storage-monitor/dashboard chrome, the
  inline AI email-assistant prompt surface) opt out via
  `// ADMIN-DIALOG-EXEMPT: <reason>` or
  `{/* ADMIN-DIALOG-EXEMPT: <reason> */}` immediately above the
  overlay opening tag.

## Deferred

- **Phase 7 — admin console onto `PlatformShell`.** The four-pattern rule
  is fully honored (workspace / wizard / peek / confirm). What remains
  is the structural migration off `AdminDashboardLayout` /
  `PlatformAdminAppLayout` onto the shared `PlatformShell` + per-workspace
  `nav.ts` described in `docs/design-system.md`. That work is planned
  page-group by page-group (Organizations & Users → Plans/Apps/Features
  → Localization → Email/Demo/Team/Groups → Settings/Infra/Audit).

## Non-goals

- No changes to tenant-facing modules — they already follow the pattern.
- No visual redesign of the admin shell beyond adopting the scaffolds.
- No schema, RLS, or business-logic changes.
- Confirmation `AlertDialog` usages remain untouched.

## Change log

- **Phase 6.1 (2026-07-13).** Closed the last four-pattern tactical gaps:
  Organizations row peek (`?peek=<orgId>`), App Catalog edit workspace
  (`/app-catalog/$id/edit`) alongside the existing inline row toggles,
  Feature Catalog read peek (`?featurePeek=<featureId>`), and the
  Generic Email Templates preview migrated from `Dialog` to
  `DocumentPeekShell` (`?templatePreview=<templateId>`).

