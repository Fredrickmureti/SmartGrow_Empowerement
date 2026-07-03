# Enterprise UX Standardization — Plan CLOSED

All planned waves for the ERP-wide interaction standardization initiative
have shipped. Sales, Purchases, Inventory, Finance and Contacts now share
the same `RecordFormShell`-based create/edit workspaces; there are no
remaining modal record forms in the app graph.

## Waves shipped

| Wave | Scope | Status | Landing files |
| --- | --- | --- | --- |
| 1–3 | Sales / Purchases / Inventory record forms | Done (prior initiative) | `src/features/{sales,purchases}/**/*{Create,Edit}Page.tsx` |
| 4–7 | Finance: Reconciliation, Bank Transfer, Bank Account | Done | `src/features/finance/{reconciliation,banking}/**` |
| 8 | Finance: Budgets (`BudgetFormSheet` / `BudgetItemSheet` / `ManageBudgetSheet` retired) | Done | `src/features/finance/budgets/{BudgetCreatePage,BudgetEditPage,CopyBudgetDetailSheet}.tsx` |
| 11 | Finance guard tightened; `finance-record-dialog-ban.test.ts` blocks `*Sheet.tsx` and verb-noun dialogs under `src/features/finance/**` | Done | `src/test/architecture/finance-record-dialog-ban.test.ts` |
| 12 | Contacts: inline `<Dialog>` in `Contacts.tsx` retired; routed create/edit at `/contacts-app/new` and `/contacts-app/:id/edit` | Done | `src/features/contacts/{ContactRecordForm,ContactCreatePage,ContactEditPage}.tsx`, `src/apps/contacts/routes.tsx`, `docs/design-system/audit/contacts.md` |

## Frozen guarantees

- No inline `<Dialog>` or `<DetailSheet>` record forms remain for Sales,
  Purchases, Inventory, Finance or Contacts create/edit flows. Every
  create/edit workspace uses `RecordFormShell`.
- Legacy `?action=create` / `?action=edit&id=` / `?sheet=…` deep links
  redirect transparently to the routed pages.
- Architecture guards under `src/test/architecture/*` are the enforcement
  mechanism going forward; extending the ban to a new module means adding
  a matching guard rather than resurrecting this plan.

## When to reopen

Only if the design language itself changes (e.g. new shell primitive or
layout contract). Module-level record-form work now goes straight to the
module's own audit ledger under `docs/design-system/audit/*.md`.
