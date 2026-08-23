import type { ExportConfig } from "@/services/reports/ReportExportService";

/**
 * The single definition of the Budget Schedule export request.
 *
 * This is deliberately a SERVER-BUILD config: no rows or columns are shipped
 * from the browser. `render-report` calls `get_budget_schedule` and
 * `get_budget_document_header`, so the PDF a controller circulates, the
 * workbook a planner flexes and the CSV another system ingests are three
 * renderings of one server answer — not three re-reads of a moving database.
 *
 * The branch is the BUDGET's own branch, never the ambient branch switcher,
 * so a company-wide budget never prints as a branch one.
 *
 * Both the budget list row menu and the budget detail page use this helper,
 * so the two surfaces can never drift apart.
 */
export type BudgetScheduleExportSource = {
  id?: string | null;
  name?: string | null;
  fiscal_year?: number | string | null;
  branch_id?: string | null;
};

export function buildBudgetScheduleExportConfig(
  budget: BudgetScheduleExportSource | null | undefined,
): ExportConfig {
  const fiscalYear = budget?.fiscal_year ?? "";
  return {
    title: `Budget Schedule – ${budget?.name || ""}`,
    reportType: "budget_schedule",
    dateFrom: `${fiscalYear}-01-01`,
    dateTo: `${fiscalYear}-12-31`,
    dateRange: `Fiscal Year ${fiscalYear}`,
    branchId: budget?.branch_id ?? null,
    filters: { budgetId: budget?.id },
    sheetName: "Budget Schedule",
    columns: [],
    rows: [],
  } as ExportConfig;
}
