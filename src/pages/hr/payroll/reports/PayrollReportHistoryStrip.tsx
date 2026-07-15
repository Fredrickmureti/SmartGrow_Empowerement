/**
 * PayrollReportHistoryStrip — collapsible strip of the last 5 runs of
 * this report from `payroll_report_runs`. Each entry links back to the
 * exact filters that produced it so users can compare their current
 * view against a recently-generated one.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ChevronDown, ChevronRight, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  organizationId: string | undefined;
  businessId: string | undefined;
  reportKey: string | undefined;
}

interface RunRow {
  id: string;
  generated_at: string;
  row_count: number | null;
  duration_ms: number | null;
  params: Record<string, unknown> | null;
}

export function PayrollReportHistoryStrip({
  organizationId,
  businessId,
  reportKey,
}: Props) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery<RunRow[]>({
    queryKey: [
      "payroll-report-history-strip",
      organizationId,
      businessId,
      reportKey,
    ],
    enabled: open && !!organizationId && !!reportKey,
    queryFn: async () => {
      let q = (supabase as any)
        .from("payroll_report_runs")
        .select("id, generated_at, row_count, duration_ms, params")
        .eq("organization_id", organizationId)
        .eq("report_key", reportKey)
        .order("generated_at", { ascending: false })
        .limit(5);
      if (businessId) q = q.eq("business_id", businessId);
      const { data } = await q;
      return Array.isArray(data) ? data : [];
    },
  });

  return (
    <div className="mt-4 rounded-md border bg-muted/20">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2 rounded-md px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <History className="h-3 w-3" />
        Recent runs
      </Button>
      {open && (
        <div className="border-t px-3 py-2 text-sm">
          {!data || data.length === 0 ? (
            <div className="py-2 text-muted-foreground">
              No prior runs recorded.
            </div>
          ) : (
            <ul className="divide-y">
              {data.map((r) => {
                const p = (r.params ?? {}) as {
                  dateFrom?: string;
                  dateTo?: string;
                };
                return (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2"
                  >
                    <span className="font-medium">
                      {format(new Date(r.generated_at), "MMM d, yyyy · HH:mm")}
                    </span>
                    {p.dateFrom && p.dateTo && (
                      <span className="text-muted-foreground">
                        {format(new Date(p.dateFrom), "MMM d")} –{" "}
                        {format(new Date(p.dateTo), "MMM d, yyyy")}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {r.row_count ?? 0} rows
                      {r.duration_ms != null ? ` · ${r.duration_ms}ms` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default PayrollReportHistoryStrip;
