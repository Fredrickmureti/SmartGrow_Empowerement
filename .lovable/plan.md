# Platform Admin UX Migration — Resumption Plan

## Verification of prior claims

Confirmed against the current tree:

- `src/pages/admin/AdminOrganizationDelete.tsx` — present, wired at `/admin-management/organizations/:id/delete` in `src/App.tsx:652`. ✅
- `src/components/admin/AdminUserPeekSheet.tsx` — present. ✅
- `MultiStepDeleteDialog.tsx` and `UserDetailsDialog.tsx` — deleted. ✅
- `PlatformAdminAppLayout` + `src/apps/platform-admin/scaffolds.tsx` substrate — present, matches `docs/design-system/audit/platform-admin.md`. ✅
- Organization Subscription workspace (`AdminOrganizationSubscription`) — wired at `.../subscription`. ✅

Still open: **25** files under `src/pages/admin` + `src/components/admin` contain `DialogContent`/`SheetContent`. Most are legitimate confirms or inline settings; the ones that violate the four-pattern rule are enumerated below. The previous agent's stated Phase 2–6 backlog is accurate — nothing has silently moved.

## Classification of remaining surfaces

Only surfaces that violate the rule (form-bearing dialog/sheet that is not a single-question confirm) are migrated. Everything else stays.

### Migrate to **workspace** routes
| Current surface | Event | New route |
|---|---|---|
| `AdminTeam.tsx` Invite dialog (lines 106–178) | Invite Member | `/admin-management/team/invite` |
| `AdminTeam.tsx` Country Scope dialog (288–322) | Edit Member Scope | `/admin-management/team/:id/edit` |
| `AdminGroups.tsx` Create/Edit dialog (156+) | Create/Edit Group | `/admin-management/groups/new`, `/groups/:id/edit` |
| `AdminLocalizationPacks.tsx` 1100 px Sheet (170–184) | View/Edit Pack | `/admin-management/localization-packs/:id` (workspace with tabs; edit inline sections) |
| `AdminLocalizationPacks.tsx` CreatePackDialog (253+) | Create Pack | `/admin-management/localization-packs/new` |
| `email/NewCampaignDialog.tsx` | New Campaign | `/admin-management/email-center/campaigns/new` |
| `email/ComposeEmailDialog.tsx` | Compose Email | `/admin-management/email-center/compose` |
| `email/AutomationSettingsDialog.tsx` | Edit Automation | `/admin-management/email-center/automations/:id` |
| `email/EmailTemplatesTab.tsx` (in-tab dialog editor) | Edit Template | `/admin-management/email-center/templates/:id/edit`, `/…/templates/new` |
| `AdminAppCatalog.tsx` edit dialog | Edit App entry | `/admin-management/app-catalog/:id/edit` |
| `SubscriptionPlansSettings.tsx` create/edit plan dialog | Create/Edit Plan | `/admin-management/plan-builder/plans/new`, `/…/plans/:id/edit` |
| `FeatureCatalogSettings.tsx` add/edit feature dialog | Create/Edit Feature | `/admin-management/plan-builder/features/new`, `/…/features/:id/edit` |
| `AdminDemoRequests.tsx` reply flow (currently mailto) | Reply to Demo Request | `/admin-management/demo-requests/:id/reply` (reuse email compose workspace) |

### Migrate to **wizard**
- Localization Pack **Publish Version** → `/admin-management/localization-packs/:id/publish` (Diff → Validate → Confirm & publish).
- Localization Pack **Install on tenant** → launched from Organization workspace at `/admin-management/organizations/:id/localization/install/:packId` (Select version → Map accounts → Confirm).

### Convert to **peek** (`?peek=<id>`)
- `AdminAppCatalog.tsx` row inspection.
- Feature Catalog read view (from `FeatureCatalogSettings`).

### Keep as **confirm** dialogs (no change)
`DeleteUserDialog`, `SuspendOrganizationDialog`, `ScheduleDeletionDialog`, `AlertDialog` in `AdminGroups` (delete), `OwnershipTransferDialog` (typed-confirm-style), `DataResetTool`, `AdminMfaStatus`, `AIProviderCard`, `MpesaEnvironmentSettings`, `BankProviderSettings`, `ExchangeRateSettings`, `AuthEmailTemplates`, `OrgEntitlementOverrides`, `StorageMonitorTab`, `DemoVideoManagement`, `AdminAIEmailAssistant`, `AdminDashboardLayout` (chrome). These are single-question confirms, inline configuration surfaces, or non-CRUD tool dialogs — the classification doc explicitly exempts them.

## Execution phases (independently shippable)

Each phase: build workspace(s) → point list page to `navigate()` → delete retired dialog file → verify build, then move on.

- **Phase 2A — Groups** (smallest, self-contained; ~200 LOC page)
  - Add `AdminGroupForm.tsx` on `AdminRecordForm` with name + permissions matrix reused from existing state in `AdminGroups.tsx`.
  - Routes `groups/new`, `groups/:id/edit`; register in `App.tsx` + `src/routes/-lazyRoutes.tsx` + `src/lib/admin/registry.ts`.
  - Remove dialog block; row `Edit` navigates. Delete unused `Dialog*` imports.
- **Phase 2B — Team**
  - `AdminTeamInvitePage` (workspace) — port invite form.
  - `AdminTeamMemberEditPage` — port country-scope editor + role assignments.
  - Update `AdminTeam.tsx` action buttons/row menu to `navigate()`.
- **Phase 3 — Plan Builder + App Catalog + Feature Catalog**
  - `AdminPlanFormPage`, `AdminAppEditPage`, `AdminFeatureFormPage` workspaces.
  - App Catalog row → `?peek=<id>`; keep tabs in `AdminPlanBuilder` intact — only the CRUD dialogs move.
- **Phase 4 — Localization Packs**
  - `AdminLocalizationPackDetail` workspace replaces the 1100 px Sheet (tabs: overview, accounts, taxes, garnishments, certificates, remittances — mirroring current sheet sections).
  - `AdminLocalizationPackCreate` workspace replaces `CreatePackDialog`.
  - `AdminLocalizationPackPublish` wizard on `AdminWizard` + `AdminWizardStepper`.
  - `AdminOrganizationLocalizationInstall` wizard.
- **Phase 5 — Email Center + Demo Requests**
  - Workspaces for compose / new campaign / edit template / automation settings.
  - `AdminEmailCenter` tabs keep their shell; the CTAs open routes instead of dialogs.
  - Demo Requests reply reuses the compose workspace (`?prefill=<demoId>`).
- **Phase 6 — Enforcement**
  - Add ESLint rule `no-dialog-crud-in-admin` (custom rule under `eslint-rules/`) that flags `DialogContent`/`SheetContent` inside `src/pages/admin/**` and `src/components/admin/**` unless the file is on an allow-list of legitimate confirm/inline-config surfaces.
  - Verify by running `tsgo` for TS errors and letting the harness type/lint the diff.

## Cross-cutting engineering rules (applied every phase)

- Every new page composes `PlatformAdminAppLayout` + `AdminRecordPage`/`AdminRecordForm`/`AdminWizard` from `@/apps/platform-admin`. No direct `RecordShell` imports in admin pages.
- Data access uses existing hooks/`adminFrom(...)`; **no** schema changes, **no** RLS changes, **no** business-logic rewrites.
- Mutations go through the existing service functions the retired dialogs used — the workspace is a thin shell around the same submit handler, wrapped in `useAdminRecordFormSubmit` for toast + redirect on success.
- Every new route registered in three places consistently: `src/App.tsx`, `src/routes/-lazyRoutes.tsx`, `src/lib/admin/registry.ts` (when it deserves palette/nav presence).
- Deletion of a retired dialog file happens in the same phase as the workspace that replaces it, so no dead code accumulates.
- Confirmation `AlertDialog` usage is left untouched.

## Verification per phase

1. `tsgo` clean.
2. Grep confirms the retired `DialogContent`/`SheetContent` is gone from that file.
3. Manual smoke via Playwright on the affected list page: row action navigates, workspace renders, submit returns to list with a toast.
4. `docs/design-system/audit/platform-admin.md` "Event → pattern map" updated if any new event surfaces during implementation.

## Out of scope

- Visual redesign of the admin shell.
- Non-admin modules.
- Schema, RLS, entitlements, or backend behavior.
- Confirm dialogs and inline configuration surfaces listed under "Keep as confirm dialogs".

## Suggested starting point

Phase 2A (Groups) — smallest surface, exercises the full workspace → route → registry → delete-dialog loop end-to-end, and de-risks the pattern before touching Team, Localization, or Email Center.
