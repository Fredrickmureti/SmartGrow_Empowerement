/**
 * RunProjectReportButton — opens the canonical ReportPreviewDialog with a
 * project_* report key pre-scoped to the current project. Same engine and
 * preview UX as Finance / Sales / Payroll reports.
 */
import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";
import { startOfYear } from "date-fns";
import { ReportPreviewDialog } from "@/components/reports/ReportPreviewDialog";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  buildProjectReportConfig,
  type ProjectReportKey,
} from "@/components/projects/projectReportConfig";

interface Props {
  /** Project id, or "*" / undefined for portfolio-wide reports. */
  projectId?: string;
  reportType: ProjectReportKey;
  title: string;
  label?: string;
}

export function RunProjectReportButton({ projectId, reportType, title, label = "Run report" }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [open, setOpen] = useState(false);

  const yearStart = useMemo(() => startOfYear(new Date()).toISOString().slice(0, 10), []);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const baseCurrency = currentBusiness?.base_currency ?? "";

  const buildConfig = () =>
    buildProjectReportConfig({
      reportType,
      projectId,
      organizationId: currentOrg?.id,
      businessId: currentBusiness?.id,
      dateFrom: yearStart,
      dateTo: today,
      title,
      currency: baseCurrency,
    });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <FileText className="h-4 w-4 mr-2" /> {label}
      </Button>
      {open && (
        <ReportPreviewDialog
          open={open}
          onOpenChange={setOpen}
          getExportConfig={buildConfig}
        />
      )}
    </>
  );
}
