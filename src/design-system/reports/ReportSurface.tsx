/**
 * ReportSurface — the on-screen document frame every financial report sits
 * inside. It is the screen twin of the PDF masthead produced by
 * `renderReport()`, and it uses the same `financial` / `operational`
 * profile split the PDF column registry uses, so the report a controller
 * reads on screen and the PDF they archive are recognisably one document.
 *
 * `financial` → centered statutory masthead: LOGO → COMPANY → Title →
 * Period/As-of → Basis → Scope → Prepared on. Used by Balance Sheet, P&L,
 * Trial Balance, Cash Flow and the other statutory statements.
 * `operational` → left-aligned title block for register-style reports.
 *
 * IDENTITY IS NOT A PROP. Company name, logo and scope come from
 * `useReportExportContext()` — the same values that are sent to
 * `render-report` as `businessId` / `branchId` — so the screen cannot
 * state one entity while the PDF states another. Pages must not pass
 * `companyName`; the prop remains only as an explicit override for
 * non-report surfaces (e.g. a consolidated group header).
 */
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatReportDate } from "./format";
import { useReportExportContext } from "@/contexts/ReportContext";

export type ReportFormatProfile = "financial" | "operational";

export interface ReportSurfaceProps {
  /**
   * Escape hatch only. Leave unset so the active business identity is
   * used — that is what the PDF masthead will print.
   */
  companyName?: string | null;
  title: string;
  /** Range reports: "1 Jan 2026 – 31 Mar 2026". */
  dateRange?: string | null;
  /** Point-in-time reports: "As of 31 March 2026". */
  asOfDate?: string | null;
  /** Basis line, e.g. "Accrual basis". Scope is NOT part of this. */
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
  const identity = useReportExportContext();
  const preparedOn = formatReportDate(new Date());
  // One masthead for every report (see BrandedHeader.ts): logo left,
  // entity block left, title/period right. `profile` still selects the
  // wording ("As of ..." vs "For the period ..."), never the layout.
  const financial = false;
  const entityName = companyName || identity.companyName || "";
  const logoUrl = identity.logoUrl || null;
  const scopeLabel = identity.scopeLabel || null;

  return (
    <Card className={cn("print:border-0 print:shadow-none", className)}>
      <CardContent className="pt-6">
        {/* Two-column masthead, mirroring drawOperationalHeader in the PDF:
            logo + entity block on the left, title/period/basis/scope/
            prepared-on right-aligned on the right. */}
        <header className="mb-4 flex flex-col gap-3 border-b-2 border-border pb-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 text-left">
            {logoUrl && (
              <img
                src={logoUrl}
                alt={entityName ? `${entityName} logo` : "Company logo"}
                className="mb-2 h-10 w-auto object-contain"
                loading="lazy"
              />
            )}
            {entityName && (
              <h2 className="text-base font-bold uppercase tracking-wide text-foreground">
                {entityName}
              </h2>
            )}
          </div>

          <div className="min-w-0 text-left sm:text-right">
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {dateRange && (
              <p className="mt-0.5 text-sm text-muted-foreground">For the period {dateRange}</p>
            )}
            {asOfDate && <p className="mt-0.5 text-sm text-muted-foreground">{asOfDate}</p>}
            {subtitle && (
              <p className="mt-0.5 text-xs italic text-muted-foreground">{subtitle}</p>
            )}
            {scopeLabel && (
              <p className="mt-0.5 text-xs text-muted-foreground">{scopeLabel}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Prepared on {preparedOn}</p>
          </div>
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
