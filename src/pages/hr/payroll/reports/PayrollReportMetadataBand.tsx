/**
 * Metadata band — the enterprise report header. Displays owner,
 * pack/template version, period, generated-at, row count. Stamped on
 * every viewer so users always know which run they are looking at.
 */
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  OWNER_LABEL,
  type PayrollReportDefinition,
} from "@/hooks/payroll/usePayrollReportDefinitions";

interface Props {
  definition: PayrollReportDefinition;
  dateFrom: string;
  dateTo: string;
  rowCount: number;
  generatedAt: Date | null;
}

export function PayrollReportMetadataBand({
  definition,
  dateFrom,
  dateTo,
  rowCount,
  generatedAt,
}: Props) {
  const meta = definition.metadata as Record<string, unknown>;
  const packVersion = (meta.pack_version as string) || null;
  const templateVersion = (meta.template_version as string) || null;
  const packCode = (meta.pack_code as string) || null;

  const cells: { label: string; value: React.ReactNode }[] = [
    {
      label: "Owner",
      value: (
        <Badge variant="outline" className="font-normal">
          {OWNER_LABEL[definition.ownerKind]}
          {definition.countryCode ? ` · ${definition.countryCode}` : ""}
        </Badge>
      ),
    },
    {
      label: "Period",
      value: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(
        new Date(dateTo),
        "MMM d, yyyy",
      )}`,
    },
    {
      label: "Generated",
      value: generatedAt ? format(generatedAt, "MMM d, yyyy · HH:mm") : "—",
    },
  ];

  if (packCode || packVersion) {
    cells.push({
      label: "Pack",
      value: `${packCode ?? "—"}${packVersion ? ` v${packVersion}` : ""}`,
    });
  }
  if (templateVersion) {
    cells.push({ label: "Template", value: `v${templateVersion}` });
  }

  return (
    <div className="mb-4 rounded-md border bg-muted/30 px-4 py-3">
      <div className="grid grid-cols-2 gap-y-2 gap-x-6 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label} className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {c.label}
            </span>
            <span className="mt-0.5">{c.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default PayrollReportMetadataBand;
