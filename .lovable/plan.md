
## Verification of prior agent's claims

Confirmed present on disk:

- Audit doc `docs/design-system/audit/platform-admin.md` (normative 4-pattern classification).
- Substrate: `@/apps/platform-admin` re-exports `AdminRecordPage`, `AdminRecordForm`, `AdminPeekShell`, `AdminWizard`, etc.
- Phase 1–5 workspace routes:
  - `pages/admin/groups/{Create,Edit}Page.tsx` (+ `AdminGroupForm`)
  - `pages/admin/team/{Invite,MemberEdit}Page.tsx`
  - `pages/admin/plan-builder/{Plan,Feature}{Create,Edit}Page.tsx` (+ shared forms)
  - `pages/admin/localization/{PackCreate,PackDetail}Page.tsx`
  - `pages/admin/email-center/{Compose,CampaignCreate,TemplateCreate,TemplateEdit,AutomationEdit}Page.tsx`
  - `pages/admin/demo-requests/DemoRequestReplyPage.tsx`
  - All registered in `routes/-lazyRoutes.tsx`.

Gaps found — the "Phase 5 complete" claim is accurate for the four listed dialogs, but three groups of form-bearing admin dialogs were **never inventoried** and still violate the classification rule, and Phase 6 lint guard does not exist:

1. `components/admin/OrgEntitlementOverrides.tsx` — "Add Entitlement Override" is a multi-field CRUD dialog on the Organization workspace. Should be a workspace sub-route or an inline record form panel.
2. `components/admin/DemoVideoManagement.tsx` — create/edit demo video is a full form dialog. Should be workspace routes.
3. `components/admin/AuthEmailTemplates.tsx` — two dialogs (Preview, Code). Read-only viewers, but large; should be peek sheets, not dialogs.
4. No `eslint-rules/no-dialog-crud-in-admin.js`, no wiring in `eslint.config.js`.
5. Deferred: Localization **Publish Pack Version** wizard and **Install Pack on tenant** wizard were never built.

All other `Dialog`/`Sheet` usages under `src/{pages,components}/admin` are either confirmation `AlertDialog`s (Suspend, DeleteUser, ScheduleDeletion, OwnershipTransfer, group delete) or exempted inline settings forms (MFA, exchange rates, bank providers, mpesa env, AI provider, data reset, storage monitor, dashboard layout chrome) — these correctly stay per the audit doc's "provider connections and toggles remain inline" clause.

## Plan

### Step 1 — Close the three form-dialog gaps missed by the prior agent

**1a. Entitlement overrides → workspace sub-route.**
- New route `/admin-management/organizations/$id/entitlements/new` and `…/entitlements/$overrideId/edit`, backed by `AdminEntitlementOverrideForm` on `RecordFormShell`.
- `OrgEntitlementOverrides` list becomes navigation-only: "Add override" links to `new`, row action links to `edit`. Delete stays as `AlertDialog` confirm.

**1b. Demo videos → workspace routes.**
- New routes `/admin-management/settings/demo-videos/new` and `/…/$id/edit` (list stays on the existing settings tab).
- `DemoVideoManagement` reduced to list + delete confirm; create/edit dialog removed.

**1c. Auth email template viewers → `DocumentPeekShell` peeks.**
- Preview + code viewers moved into `AdminPeekShell` (`?peek=<templateId>&mode=preview|code`) so they match every other read-mostly admin surface.

Each migration follows the audit doc's 6-step checklist: classify → route → lazy-register → build from scaffolds → remove dialog + state → verify build clean.

### Step 2 — Deferred Localization wizards

**2a. Publish Pack Version wizard** at `/admin-management/localization-packs/$id/publish` using `AdminWizard` + `AdminWizardStepper`:

```text
Step 1: Version metadata (semver, changelog)
Step 2: Diff review (rules added/changed/removed vs current published)
Step 3: Compatibility checks (tenant install impact preview)
Step 4: Confirm & publish (typed confirmation → mutation)
```

Launched from the pack detail workspace "Publish new version" action; commit call reuses existing `pack_versions` insert + `localization_packs.published_version_id` update path — **no schema changes**.

**2b. Install Pack on tenant wizard** at `/admin-management/organizations/$id/localization/install`:

```text
Step 1: Choose pack + version
Step 2: Country/currency confirmation
Step 3: Conflict resolution (existing installed pack differences)
Step 4: Confirm & install (writes installed_localization_packs)
```

Entry point added on the Organization workspace subscription/localization section.

### Step 3 — Phase 6 lint guard

- Add `eslint-rules/no-dialog-crud-in-admin.js`: reports `DialogContent` / `SheetContent` JSX inside `src/pages/admin/**` and `src/components/admin/**` when the subtree contains a form control (`input`, `select`, `textarea`, `<Form>`, `useForm`). Allow-list: files importing from `@/components/ui/alert-dialog`, plus an explicit exemption list of settings-inline components enumerated in the audit doc (MFA, exchange rates, bank providers, mpesa env, AI provider, data reset, storage monitor, dashboard layout).
- Wire the rule into `eslint.config.js` for those two globs at `error` level.
- Run lint; fix any residual violations by either migrating (if CRUD) or adding to the exemption list with a code-comment rationale.

### Step 4 — Verification

- `tsgo` clean.
- `bunx eslint src/pages/admin src/components/admin` clean.
- Playwright smoke on `/admin-management/organizations/<id>` → click "Add entitlement override" → workspace opens (not a dialog). Same for demo videos + localization publish flow. Screenshot each.
- Update audit doc §"Event → pattern map" to add the three newly-classified events and check off Phase 6.

### Technical details

- New forms compose `AdminRecordForm` + `useAdminRecordFormSubmit`; no bespoke submit logic.
- All new routes registered in `src/routes/-lazyRoutes.tsx` and mounted in `App.tsx` under the existing `/admin-management` guard so MFA + role checks are inherited.
- Command palette entries via `src/lib/admin/registry.ts` only for top-level pages (publish/install wizards are contextual, not palette-visible).
- No DB migrations, no RLS changes, no edge-function changes.

### Out of scope

- Visual redesign of admin shell.
- Any tenant-facing module changes.
- Retiring the confirmation `AlertDialog`s — they are the sanctioned pattern.
