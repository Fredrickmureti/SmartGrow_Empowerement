/**
 * LibraryPanel — searchable browser of every report definition, grouped
 * by owner rail (Payroll Engine, Cost & Finance, Compliance, Management,
 * Audit, HR). Opens each report in the dedicated viewer route.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search, ArrowRight } from "lucide-react";

import { useBusinesses } from "@/hooks/useBusinesses";
import {
  usePayrollReportDefinitions,
  groupPayrollReportsByOwner,
  OWNER_LABEL,
  type PayrollReportDefinition,
} from "@/hooks/payroll/usePayrollReportDefinitions";

function ReportRow({ d }: { d: PayrollReportDefinition }) {
  const primaryFormat = d.exportFormats.find((f) => f.isPrimary) ?? d.exportFormats[0];
  return (
    <Link
      to={`/hr/payroll/reports/${d.reportKey}`}
      className="group flex items-center justify-between rounded-md border bg-card p-3 hover:border-primary/40 hover:bg-muted/40 transition"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{d.label}</span>
          {d.countryCode && (
            <Badge variant="outline" className="text-[10px]">
              {d.countryCode}
            </Badge>
          )}
        </div>
        {d.description && (
          <div className="mt-0.5 text-xs text-muted-foreground truncate">
            {d.description}
          </div>
        )}
      </div>
      <div className="ml-3 flex items-center gap-2 shrink-0">
        {primaryFormat && (
          <Badge variant="secondary" className="text-[10px] uppercase font-normal">
            {primaryFormat.format}
          </Badge>
        )}
        <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
      </div>
    </Link>
  );
}

export function LibraryPanel() {
  const { currentBusiness } = useBusinesses();
  const { data: defs, isLoading } = usePayrollReportDefinitions(
    (currentBusiness as any)?.country_code ?? null,
  );
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    if (!defs) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return defs;
    return defs.filter((d) => {
      return (
        d.label.toLowerCase().includes(needle) ||
        d.reportKey.toLowerCase().includes(needle) ||
        (d.description ?? "").toLowerCase().includes(needle)
      );
    });
  }, [defs, q]);

  const groups = groupPayrollReportsByOwner(filtered);

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search reports by name, key, or description…"
          className="pl-8"
        />
      </div>

      {isLoading && (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground text-center">
            Loading report library…
          </CardContent>
        </Card>
      )}

      {!isLoading && groups.length === 0 && (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground text-center">
            No reports match your search.
          </CardContent>
        </Card>
      )}

      {groups.map((g) => (
        <section key={g.owner}>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-semibold">{OWNER_LABEL[g.owner]}</h3>
            <span className="text-xs text-muted-foreground">
              {g.items.length} report{g.items.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {g.items.map((d) => (
              <ReportRow key={d.id} d={d} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default LibraryPanel;
