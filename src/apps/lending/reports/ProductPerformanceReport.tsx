/**
 * Loan product performance — how each product is performing across its book.
 * Every figure is read from the server view `mf_product_performance`, which
 * aggregates loans, disbursements and the authoritative balance view.
 */
import { useCallback, useMemo } from "react";
import { format } from "date-fns";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import {
  ReportSurface,
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { useMfProductPerformance } from "@/hooks/useMfReports";
import type { ExportConfig } from "@/services/reports/ReportExportService";

const COLUMNS: ReportColumn[] = [
  { key: "product", header: "Product", width: "w-[220px]", sticky: true },
  { key: "loan_count", header: "Loans", format: "number", width: "w-[90px]" },
  { key: "active_loan_count", header: "Active", format: "number", width: "w-[90px]" },
  { key: "closed_loan_count", header: "Closed", format: "number", width: "w-[90px]" },
  { key: "written_off_loan_count", header: "Written off", format: "number", width: "w-[110px]" },
  { key: "principal_disbursed", header: "Disbursed", format: "currency", width: "w-[150px]" },
  { key: "outstanding", header: "Outstanding", format: "currency", width: "w-[150px]" },
  { key: "amount_overdue", header: "Overdue", format: "currency", width: "w-[140px]" },
  { key: "worst_days_past_due", header: "Worst DPD", format: "number", width: "w-[110px]" },
];

export function ProductPerformanceReport() {
  const { rows: data, isLoading, error } = useMfProductPerformance();
  const asOf = format(new Date(), "d MMM yyyy");

  const rows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = data.map((p) => ({
      id: p.product_id,
      kind: "detail",
      tone: p.amount_overdue > 0 ? "warning" : undefined,
      values: {
        product: `${p.product_name} (${p.product_code})`,
        loan_count: p.loan_count,
        active_loan_count: p.active_loan_count,
        closed_loan_count: p.closed_loan_count,
        written_off_loan_count: p.written_off_loan_count,
        principal_disbursed: p.principal_disbursed,
        outstanding: p.outstanding,
        amount_overdue: p.amount_overdue,
        worst_days_past_due: p.worst_days_past_due,
      },
    }));
    if (detail.length === 0) return detail;
    detail.push({
      id: "total",
      kind: "grandTotal",
      label: "All products",
      values: {
        product: "All products",
        loan_count: data.reduce((s, p) => s + p.loan_count, 0),
        active_loan_count: data.reduce((s, p) => s + p.active_loan_count, 0),
        closed_loan_count: data.reduce((s, p) => s + p.closed_loan_count, 0),
        written_off_loan_count: data.reduce((s, p) => s + p.written_off_loan_count, 0),
        principal_disbursed: data.reduce((s, p) => s + p.principal_disbursed, 0),
        outstanding: data.reduce((s, p) => s + p.outstanding, 0),
        amount_overdue: data.reduce((s, p) => s + p.amount_overdue, 0),
      },
    });
    return detail;
  }, [data]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Product performance",
      asOf,
      columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
      rows: toExportRows(rows, COLUMNS as ReportColumn<never>[]),
      sheetName: "Products",
    }),
    [rows, asOf],
  );

  return (
    <ReportPageLayout
      title="Product performance"
      description="Loans, disbursement, outstanding and overdue per loan product"
      isLoading={isLoading}
      error={error}
      isEmpty={!isLoading && data.length === 0}
      emptyMessage="No loans have been written against any product yet"
      getExportConfig={getExportConfig}
    >
      <ReportSurface title="Product performance" asOfDate={`As of ${asOf}`}>
        <ReportTable columns={COLUMNS as ReportColumn<never>[]} rows={rows} />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default ProductPerformanceReport;
