/**
 * ProjectReportsMenu — single dropdown exposing every project_* report key
 * for the current project. Replaces the per-tab "Run report" buttons; mounts
 * once in the ProjectDetailLayout header so the same surface is available
 * from Overview, Tasks, Milestones, Timesheets, Sales, Purchases, Financials,
 * Documents, Updates, Activity, and Settings.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { FileText, ChevronDown } from "lucide-react";
import { startOfYear } from "date-fns";
import { ReportPreviewDialog } from "@/components/reports/ReportPreviewDialog";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  buildProjectReportConfig,
  type ProjectReportKey as ReportKey,
} from "@/components/projects/projectReportConfig";
import type { ExportConfig } from "@/services/reports/ReportExportService";

const REPORTS: Array<{ key: ReportKey; label: string; group: "this" | "portfolio" }> = [
  { key: "project_status",            label: "Status report",        group: "this" },
  { key: "project_profitability",     label: "Profitability",        group: "this" },
  { key: "project_timesheet_detail",  label: "Timesheet detail",     group: "this" },
  { key: "project_full_export",       label: "Full export",          group: "this" },
  { key: "project_portfolio",         label: "Portfolio (all)",      group: "portfolio" },
  { key: "project_workload",          label: "Workload (all)",       group: "portfolio" },
];

interface Props {
  projectId: string;
  projectName: string;
}

export function ProjectReportsMenu({ projectId, projectName }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<{ key: ReportKey; label: string } | null>(null);

  const yearStart = useMemo(() => startOfYear(new Date()).toISOString().slice(0, 10), []);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const baseCurrency = currentBusiness?.base_currency ?? "";

  function buildConfig(): ExportConfig {
    if (!active) {
      return {
        title: "Project report",
        columns: [],
        rows: [],
      } as ExportConfig;
    }
    const meta = REPORTS.find((r) => r.key === active.key);
    const scopedProjectId = meta?.group === "this" ? projectId : undefined;
    return buildProjectReportConfig({
      reportType: active.key,
      projectId: scopedProjectId,
      organizationId: currentOrg?.id,
      businessId: currentBusiness?.id,
      dateFrom: yearStart,
      dateTo: today,
      title: `${active.label} — ${projectName}`,
      currency: baseCurrency,
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <FileText className="h-4 w-4 mr-2" /> Reports <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>This project</DropdownMenuLabel>
          {REPORTS.filter((r) => r.group === "this").map((r) => (
            <DropdownMenuItem
              key={r.key}
              onSelect={() => {
                setActive({ key: r.key, label: r.label });
                setOpen(true);
              }}
            >
              {r.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Portfolio</DropdownMenuLabel>
          {REPORTS.filter((r) => r.group === "portfolio").map((r) => (
            <DropdownMenuItem
              key={r.key}
              onSelect={() => {
                setActive({ key: r.key, label: r.label });
                setOpen(true);
              }}
            >
              {r.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {open && active && (
        <ReportPreviewDialog
          open={open}
          onOpenChange={(v) => {
            setOpen(v);
            if (!v) setActive(null);
          }}
          getExportConfig={buildConfig}
        />
      )}
    </>
  );
}
