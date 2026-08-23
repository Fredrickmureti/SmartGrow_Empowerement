# Budget exports: fix the 500 and surface downloads on the list

## What I verified

1. **The PDF failure is a stale deployment, not broken code.**
   The live edge-function log for `render-report` shows:
   `Error: Unsupported report type: budget_schedule` thrown from the dispatcher's
   `default:` branch. The repository copy of `supabase/functions/render-report/index.ts`
   *does* handle `budget_schedule` (it calls `buildBudgetSchedule`, which in turn calls the
   `get_budget_schedule` / `get_budget_document_header` SQL functions, both present in
   migrations `20260823002411` and `20260823002613`). So the deployed function predates the
   budget work — the client, the column specs and the SQL are all in place.

2. **The budget list has no export actions.**
   `src/pages/Budgets.tsx` row menu offers only View & Manage, Edit, Copy to Next Year,
   Activate/Close, Delete. The export toolbar (`ReportExportButtons` with
   `reportType: "budget_schedule"`) exists only on `BudgetEditPage`, which is why downloads
   are reachable only after opening a budget.

## Work

### 1. Redeploy `render-report`
Deploy the current `render-report` function (with its `_shared` report engine, column specs
and branch-scopability tables) so the `budget_schedule` case exists server-side. Then verify
by invoking it for a real budget id and confirming a 200 with schedule rows, and re-check the
function logs for errors.

### 2. Share one export config
Move the schedule `ExportConfig` builder out of `BudgetEditPage` into a small shared helper
(e.g. `src/features/finance/budgets/budgetScheduleExport.ts`) that takes a budget row and
returns the same server-build config: `reportType: "budget_schedule"`, fiscal-year date
range, the budget's own `branch_id`, `filters.budgetId`, and empty `columns`/`rows`.
`BudgetEditPage` then imports it instead of defining it inline — one definition, so the list
and the detail page can never drift apart.

### 3. Add exports to the budget list row menu
In `src/pages/Budgets.tsx`, add a section to each row's dropdown (after View & Manage,
separated):

```text
Download PDF
Print
Export Excel
Export CSV
```

Each item builds the shared config for that row, enriches it through the existing report
export context (`useReportExportContext().enrichExportConfig`, so org branding/currency
context is applied exactly as on the detail page) and calls the matching
`ReportExportService` function (`exportToPDF`, `printReportAsPdf`, `exportToExcel`,
`exportToCSV`). Items show a spinner/disabled state while generating and surface the same
success/failure toasts. These are read actions, so they are not gated behind
`canManageBudgets` — they appear for read-only users too.

## Explicitly not doing

- No change to the budget document model, the schedule SQL, or the PDF layout — the earlier
  plan's architecture stands; this is the delivery gap only.
- Not embedding the full `ReportExportButtons` toolbar in a table cell (it renders its own
  button group and dialogs); the row menu reuses the same service calls instead.

## Verification

- Invoke `render-report` for an existing budget and confirm a 200 plus non-empty schedule.
- In the preview, open Budgets, use the row menu to download the PDF, and confirm the file
  generates and the console is clean.
