/**
 * Financial Report Header Component
 * 
 * Professional header block for financial statements showing:
 * - Company name
 * - Report title
 * - Period / As-of date
 * - Prepared date
 * 
 * Used consistently across Balance Sheet, P&L, Trial Balance, Cash Flow.
 */

import { format } from "date-fns";

interface FinancialReportHeaderProps {
  companyName: string;
  reportTitle: string;
  /** For range-based reports (P&L): "Jan 1, 2026 – Mar 31, 2026" */
  dateRange?: string;
  /** For point-in-time reports (BS): "As of March 31, 2026" */
  asOfDate?: string;
  /** Optional subtitle (e.g., "Accrual Basis") */
  subtitle?: string;
}

export function FinancialReportHeader({
  companyName,
  reportTitle,
  dateRange,
  asOfDate,
  subtitle,
}: FinancialReportHeaderProps) {
  const preparedDate = format(new Date(), "MMMM d, yyyy");

  return (
    <div className="text-center py-4 mb-2 border-b-2 border-border">
      <h2 className="text-lg font-bold tracking-tight text-foreground uppercase">
        {companyName}
      </h2>
      <h3 className="text-base font-semibold text-foreground mt-1">
        {reportTitle}
      </h3>
      {dateRange && (
        <p className="text-sm text-muted-foreground mt-0.5">
          For the period {dateRange}
        </p>
      )}
      {asOfDate && (
        <p className="text-sm text-muted-foreground mt-0.5">
          {asOfDate}
        </p>
      )}
      {subtitle && (
        <p className="text-xs text-muted-foreground mt-0.5 italic">{subtitle}</p>
      )}
      <p className="text-xs text-muted-foreground mt-1">
        Prepared on {preparedDate}
      </p>
    </div>
  );
}
