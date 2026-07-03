## Context

Chart of Accounts is done (routed create/edit on `RecordFormShell`, inline dialog removed, redirect in place, typecheck + finance guard green). The rest of Slice B3 — **Analytic Accounts**, **Fiscal Periods**, **Year-End Close** — is still legacy: `src/pages/AnalyticAccounts.tsx` hosts two inline `<Dialog>`s (account + group), `src/pages/FiscalPeriods.tsx` hosts a create `<Dialog>` and mounts `YearEndClosingDialog`, and `src/components/finance/YearEndClosingDialog.tsx` is the last remaining legacy modal for the close workflow.

This slice migrates all three to the enterprise design-system scaffolds, using the same pattern already applied to Journal Entries and CoA. No new primitives, no business-logic changes — only interaction architecture and route wiring.

## Scope (one entity at a time, verified before moving on)

### 1. Analytic Accounts — `DetailSheet` create/edit
Two entities live on this page: **analytic accounts** (≤6 fields: code, name, group, parent, active, description) and **analytic groups** (≤3 fields: code, name, description). Both are lightweight configuration records → `DetailSheet` is the right scaffold (matches design-system audit rule: ≤6 fields = sheet, not a full record page).

- New: `src/features/finance/analytic-accounts/AnalyticAccountSheet.tsx` (create + edit modes, `useRecordFormSubmit`, `FieldGrid`).
- New: `src/features/finance/analytic-accounts/AnalyticGroupSheet.tsx`.
- Edit `src/pages/AnalyticAccounts.tsx`: delete both inline `<Dialog>` blocks and their `useState` gates; mount the two sheets driven by a single `sheet` URL param (`?sheet=account|group&id=<uuid>`) so deep-links work and the browser back button closes the sheet.
- Preserve every RPC (`useAnalyticAccounts` mutations), toast copy, delete-confirm flow, RLS-scoped queries.

### 2. Fiscal Periods — `DetailSheet` create/edit + list page cleanup
- New: `src/features/finance/fiscal-periods/FiscalPeriodSheet.tsx` (name, fiscal_year, start_date, end_date, status). Uses `DetailSheet` + `useRecordFormSubmit`.
- Edit `src/pages/FiscalPeriods.tsx`: delete the create `<Dialog>` and its `Dialog*` imports; mount the sheet behind `?sheet=period[&id=...]`; keep the Year-End action pointing at the new route (below), not the old modal.
- `FiscalPeriodDetail.tsx` already exists as the detail page — leave it in place; add an "Edit" button that opens the sheet with `?sheet=period&id=<id>` for parity.

### 3. Year-End Close — `WizardShell` at `/finance/fiscal-periods/close`
The close workflow is a real multi-step process (choose period → preview adjustments → post & lock). It belongs on a full page, not a dialog.

- New route: `/finance/fiscal-periods/close` registered in `src/apps/finance/routes.tsx` (under `SubscriptionProtectedRoute`, no `allowReadOnly`).
- New: `src/features/finance/year-end-close/YearEndCloseWizard.tsx` composed on `WizardShell` with three steps:
  1. **Scope** — pick fiscal period, retained-earnings account, closing date.
  2. **Preview** — read-only summary of P&L accounts to be zeroed and the resulting adjusting entry (calls the same RPC/helpers `YearEndClosingDialog` uses today for preview; no logic change).
  3. **Post & lock** — confirm, submit, redirect to the newly created journal entry's record page on success.
- All existing side effects (RPC calls, lock-date update, toasts, invalidations) are lifted verbatim out of `YearEndClosingDialog` into the wizard's step handlers.
- Replace the Year-End trigger in `FiscalPeriods.tsx` with a `<Link>` to the new route (pre-select current period via `?periodId=`).
- Delete `src/components/finance/YearEndClosingDialog.tsx` once no references remain.

## Guardrails / verification (must pass before closing the slice)

- `rg "YearEndClosingDialog|AnalyticAccountDialog|FiscalPeriodDialog"` → zero hits outside of git history.
- No `<Dialog` JSX left in `AnalyticAccounts.tsx` or `FiscalPeriods.tsx` (only `ConfirmDeleteDialog`, which is the shared confirm primitive and out of scope).
- Deep-links resolve: `/finance/analytic-accounts?sheet=account`, `/finance/fiscal-periods?sheet=period`, `/finance/fiscal-periods/close?periodId=<uuid>`.
- Finance dialog-ban guard test stays green; if the inline `<Dialog>` scan from Slice B7 is not yet in place, the filename-based guard is still enforced.
- `bunx tsgo --noEmit` clean.
- Preserve branch/business scoping and RLS on every query and mutation — no changes to `useAnalyticAccounts`, `useFiscalPeriods`, or the year-end RPCs.

## Out of scope for this slice

Budgets, Fixed Assets, Banking (B4/B5), Customer Credits (B6), and the guard extension (B7). Those pick up in subsequent slices, in the order the master plan already defines.

## Technical notes

- Reuse only `@/design-system` scaffolds: `RecordFormShell`, `DetailSheet`, `WizardShell`, `FieldGrid`, `FooterActionBar`, `useRecordFormSubmit`. Do not import from `@/features/sales/*`.
- URL-driven sheets (not React state) so the back button, refresh, and shared links behave correctly — matches the pattern used by Sales/Purchases peek sheets.
- Wizard step state stays local to the wizard component; only the final commit hits the network. Preview step calls the existing read-only RPC used by the current dialog.
- Delete legacy files in the same commit that removes their last import to keep the guard clean.
