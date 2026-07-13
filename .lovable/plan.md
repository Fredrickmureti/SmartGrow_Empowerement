# Platform Admin UX — Verification & Completion Plan

## What I verified from the prior agent's work

Independently checked every claim against the codebase, not the handoff note:

- `docs/design-system/audit/platform-admin.md` exists and is normative — the four-pattern rule (workspace / wizard / peek / confirm) is codified.
- Phase 0 substrate real: `@/apps/platform-admin` re-exports `AdminRecordPage`, `AdminRecordForm`, `AdminPeekShell`, `AdminWizard`.
- Workspaces exist for: Organizations (edit, subscription, delete wizard, entitlement overrides create/edit), Users (detail), Team (invite / member edit), Groups (create/edit), Plan Builder (plan + feature create/edit), Localization Packs (create/edit + publish wizard), Email Center (campaign, template, automation, compose), Demo Requests (reply), Settings → Demo Videos (create/edit).
- Install-Pack-on-tenant wizard **is** wired: `src/pages/admin/organizations/AdminOrgLocalizationInstallPage.tsx`, registered in `-lazyRoutes.tsx`, routed at `/admin-management/organizations/:id/localization/install`, entered from a `Localization` tab on the org workspace. Edge function `install-localization-pack` accepts on-behalf-of callers.
- The lint rule `no-dialog-crud-in-admin` exists and is wired into `eslint.config.js` at error level.

## What the prior agent got wrong or left unfinished

1. **Lint guard is a no-op.** `eslint.config.js` fails to load because `eslint-rules/no-direct-employees-branch-write.js` still uses `module.exports = { ... }` while the config imports it as an ESM default. ESLint aborts with `SyntaxError: does not provide an export named 'default'` before it can enforce anything — including `no-dialog-crud-in-admin`. Phase 6 is effectively unenforced.
2. **Form-bearing overlays still live in `src/{pages,components}/admin/**`** without `ADMIN-DIALOG-EXEMPT` markers and without matching the doc's classification:
   - `components/admin/OwnershipTransferDialog.tsx` — `Dialog` + `Select` + confirm. Doc: confirm dialog.
   - `components/admin/ScheduleDeletionDialog.tsx` — `Dialog` + `Input`/`Textarea`. Doc: confirm dialog.
   - `components/admin/SuspendOrganizationDialog.tsx` — `Dialog` + `Textarea` reason. Doc: confirm dialog.
   - `components/admin/DeleteUserDialog.tsx` — `Dialog` + typed-confirm `Input`. Doc: confirm dialog.
   - `components/admin/email/EmailTemplatesTab.tsx` — preview `Dialog`. Doc: preview → peek.
   - `components/admin/email/AdminAIEmailAssistant.tsx` — two `Dialog`s with `Textarea` prompts for AI generation. Doc silent; classify as inline assistant → exempt.
   - `pages/admin/AdminGroups.tsx` — `AlertDialog` only (delete). Already compliant.
   - `components/admin/DemoVideoManagement.tsx`, `OrgEntitlementOverrides.tsx` — `AlertDialog` only (delete confirms). Compliant.
   - Settings/provider/infra files (BankProviderSettings, MpesaEnvironmentSettings, ExchangeRateSettings, AIProviderCard, DataResetTool, StorageMonitorTab, AdminMfaStatus, AdminDashboardLayout) are legitimately exempt per doc — they lack the marker only because the lint step never ran.

## Work to execute (in order, each independently shippable)

### 1. Repair the lint substrate so the guard actually runs

- Rewrite `eslint-rules/no-direct-employees-branch-write.js` to use `export default { ... }` (matches the sibling ESM rules).
- Re-run `npx eslint 'src/pages/admin/**' 'src/components/admin/**'` and drive violations to zero. Every failure below feeds into steps 2–4.

### 2. Convert the four "confirm-shape" dialogs from `Dialog` to `AlertDialog`

The doc explicitly classifies these as confirm dialogs. `AlertDialog` is the primitive exempted by the lint rule. Preserve current behavior (reason field, typed confirmation, target-user select stay) — swap the wrapper components only:

- `SuspendOrganizationDialog.tsx` → `AlertDialog` with `Textarea` reason retained.
- `ScheduleDeletionDialog.tsx` → `AlertDialog` with date `Input` + reason `Textarea` retained.
- `DeleteUserDialog.tsx` → `AlertDialog` with typed-confirm `Input` retained.
- `OwnershipTransferDialog.tsx` → `AlertDialog` with target-user `Select` + typed confirm retained.

Each keeps the same public props and callsites; only the shell changes. This matches the doc and satisfies the lint rule without needing an exempt marker.

### 3. Migrate the Email template preview to a peek sheet

- Replace the `Dialog`-based preview in `EmailTemplatesTab.tsx` with `AdminPeekShell` (`?emailTemplatePeek=<id>&mode=preview|code`) matching the existing Auth Email Templates peek pattern documented in the audit.
- Peek shows Preview / HTML tabs, "Open full page" → existing `AdminEmailTemplateEditPage`.

### 4. Mark legitimate inline-settings overlays exempt

Add a single-line `// ADMIN-DIALOG-EXEMPT: <reason>` above each `DialogContent` / `SheetContent` in the eight settings/infra components the doc already whitelists (BankProviderSettings, MpesaEnvironmentSettings, ExchangeRateSettings, AIProviderCard, DataResetTool, StorageMonitorTab, AdminMfaStatus, AdminDashboardLayout) plus `AdminAIEmailAssistant` (inline AI generator). No behavior change.

### 5. Documentation & audit trail

- Update `docs/design-system/audit/platform-admin.md` "Migration order" section: mark Phase 6 **enforced** once step 1 lands; add the four confirm-dialog conversions and the email-template peek to the Phase 5.5 completion list; note the AI assistant exemption in the exempt list.
- No schema, RLS, or business-logic changes.

### 6. Verification checklist before hand-off

- `npx eslint 'src/pages/admin/**' 'src/components/admin/**'` exits 0.
- `rg "^import.*from \"@/components/ui/dialog\"" src/pages/admin src/components/admin` returns only marked/exempt files or peek-shell consumers.
- `tsgo` clean.
- Manual smoke: suspend org, schedule deletion, delete user, transfer ownership, preview email template, install pack on tenant — every flow still completes end-to-end.

## Technical notes

- `AlertDialog` supports arbitrary children (form controls render fine); the lint rule exempts it by tag name.
- The peek migration for email templates reuses `usePeekParam` + `AdminPeekShell` — no new primitives.
- The lint rule fix is a one-line export change; no config edit required.

## Out of scope

- Any tenant module changes.
- Visual redesign of the admin shell.
- Further work on the deferred install-pack wizard (already shipped by prior agent).
- Tailwind v3 → v4.
