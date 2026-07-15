/**
 * ReportingCentre — enterprise landing for the Payroll Reports module.
 *
 * Four tabs: Overview | Library | Scheduled | History.
 *
 *   • Overview  — payroll health for the current period: KPI strip,
 *                 recent runs, latest report generations.
 *   • Library   — searchable browser of every active report definition
 *                 in the registry, grouped by owner rail. Opening a
 *                 report navigates to /hr/payroll/reports/:reportKey.
 *   • Scheduled — payroll-scoped rows from `scheduled_reports`.
 *   • History   — `payroll_report_runs`, most recent first.
 *
 * The landing intentionally does NOT run a report. Opening a report is
 * a distinct URL, deep-linkable, back-button friendly. That is the
 * critical architectural shift over the old tab-chip page.
 */
import { useMemo, useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import {
  ReportFilterProvider,
  useReportFilters,
} from "@/contexts/ReportFilterContext";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { PayrollReportsKpiStrip } from "../PayrollReportsKpiStrip";
import { LibraryPanel } from "./panels/LibraryPanel";
import { OverviewPanel } from "./panels/OverviewPanel";
import { HistoryPanel } from "./panels/HistoryPanel";
import { ScheduledPanel } from "./panels/ScheduledPanel";

function CentreInner() {
  const now = new Date();
  const { filters } = useReportFilters();
  const [tab, setTab] = useState<"overview" | "library" | "scheduled" | "history">(
    "overview",
  );
  const [dateFrom, setDateFrom] = useState(
    filters.dateFrom || format(startOfMonth(now), "yyyy-MM-dd"),
  );
  const [dateTo, setDateTo] = useState(
    filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"),
  );

  const description = useMemo(
    () =>
      "Reporting workspace for payroll. Every report has an owner, a preview, and declared export formats. Localization packs contribute their statutory reports directly into the library.",
    [],
  );

  return (
    <ReportPageLayout
      title="Payroll Reporting Centre"
      description={description}
      filters={
        <ReportFilters
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
        >
          <ReportBranchFilter reportKind="journal" />
        </ReportFilters>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <PayrollReportsKpiStrip dateFrom={dateFrom} dateTo={dateTo} />
          <OverviewPanel />
        </TabsContent>
        <TabsContent value="library" className="mt-4">
          <LibraryPanel />
        </TabsContent>
        <TabsContent value="scheduled" className="mt-4">
          <ScheduledPanel />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <HistoryPanel />
        </TabsContent>
      </Tabs>
    </ReportPageLayout>
  );
}

/**
 * Public entry — this is what PayrollRoutes wires at `/hr/payroll/reports`.
 * The old `PayrollReportsPage` name is re-exported by `sections.tsx` for
 * backward-compat with the lazy loader.
 */
export function PayrollReportingCentre() {
  return (
    <ReportFilterProvider>
      <CentreInner />
    </ReportFilterProvider>
  );
}

export default PayrollReportingCentre;
