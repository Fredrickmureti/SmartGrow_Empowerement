/**
 * ReportSurface — the on-screen document frame every financial report sits
 * inside. It is the screen twin of the PDF masthead produced by
 * `renderReport()`, and it uses the same `financial` / `operational`
 * profile split the PDF column registry uses, so the report a controller
 * reads on screen and the PDF they archive are recognisably one document.
 *
 * `financial` → centered statutory masthead: COMPANY → Title → Period →
 * Basis → Prepared on. Used by Balance Sheet, P&L, Trial Balance, Cash
 * Flow and the other statutory statements.
 * `operational` → left-aligned title block for register-style reports.
 */
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatReportDate } from "./format";

export type ReportFormatProfile = "financial" | "operational";

export interface ReportSurfaceProps {
  companyName?: string | null;
  title: string;
  /** Range reports: "1 Jan 2026 – 31 Mar 2026". */
  dateRange?: string | null;
  /** Point-in-time reports: "As of 31 March 2026". */
  asOfDate?: string | null;
  /** Basis / scope line, e.g. "Accrual basis · Nairobi branch". */
  subtitle?: string | null;
  profile?: ReportFormatProfile;
  /** Rendered under the masthead, above the table (status banners, etc.). */
  banner?: ReactNode;
  footnote?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ReportSurface({
  companyName,
  title,
  dateRange,
  asOfDate,
  subtitle,
  profile = "financial",
  banner,
  footnote,
  children,
  className,
}: ReportSurfaceProps) {
  const preparedOn = formatReportDate(new Date());
  const financial = profile === "financial";

  return (
    <Card className={cn("print:border-0 print:shadow-none", className)}>
      <CardContent className="pt-6">
        <header
          className={cn(
            "mb-4 border-b-2 border-border pb-3",
            financial ? "text-center" : "text-left",
          )}
        >
          {companyName && (
            <h2 className="text-base font-bold uppercase tracking-wide text-foreground">
              {companyName}
            </h2>
          )}
          <h3 className="mt-0.5 text-base font-semibold text-foreground">{title}</h3>
          {dateRange && (
            <p className="mt-0.5 text-sm text-muted-foreground">For the period {dateRange}</p>
          )}
          {asOfDate && <p className="mt-0.5 text-sm text-muted-foreground">{asOfDate}</p>}
          {subtitle && (
            <p className="mt-0.5 text-xs italic text-muted-foreground">{subtitle}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">Prepared on {preparedOn}</p>
        </header>

        {banner && <div className="mb-4">{banner}</div>}

        {children}

        {footnote && (
          <footer className="mt-4 border-t border-border pt-2 text-xs text-muted-foreground">
            {footnote}
          </footer>
        )}
      </CardContent>
    </Card>
  );
}
