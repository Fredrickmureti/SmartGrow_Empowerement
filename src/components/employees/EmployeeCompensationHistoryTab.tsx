/**
 * Compensation History tab — audit trail of pay component changes.
 * Sourced from employee_compensation_history (auto-populated by DB trigger).
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrency } from "@/hooks/useCurrency";
import { History } from "lucide-react";
import { format } from "date-fns";

interface Row {
  id: string;
  effective_date: string;
  basic_salary: number;
  allowances_json: Record<string, number> | null;
  change_type: string;
  reason: string | null;
  created_at: string;
}

export function EmployeeCompensationHistoryTab({ employeeId }: { employeeId: string }) {
  const { formatCurrency } = useCurrency();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("employee_compensation_history")
        .select("id, effective_date, basic_salary, allowances_json, change_type, reason, created_at")
        .eq("employee_id", employeeId)
        .order("effective_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (active) {
        setRows((data ?? []) as unknown as Row[]);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [employeeId]);

  const totalOf = (r: Row) => {
    const alw = r.allowances_json || {};
    return (
      Number(r.basic_salary || 0) +
      Number(alw.housing_allowance || 0) +
      Number(alw.transport_allowance || 0) +
      Number(alw.other_allowances || 0)
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-4 w-4" /> Compensation History
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No compensation changes recorded yet.
          </p>
        ) : (
          <div className="relative">
            <div className="absolute left-3 top-2 bottom-2 w-px bg-border" />
            <div className="space-y-4">
              {rows.map((r, idx) => {
                const prev = rows[idx + 1];
                const delta = prev ? totalOf(r) - totalOf(prev) : 0;
                const alw = r.allowances_json || {};
                return (
                  <div key={r.id} className="relative pl-8">
                    <div className="absolute left-2 top-1.5 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-background" />
                    <div className="rounded-md border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {format(new Date(r.effective_date), "MMM d, yyyy")}
                          </span>
                          <Badge variant="outline" className="capitalize">
                            {r.change_type}
                          </Badge>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">
                            {formatCurrency(totalOf(r))}
                          </div>
                          {prev && delta !== 0 && (
                            <div
                              className={`text-xs ${delta > 0 ? "text-emerald-600" : "text-destructive"}`}
                            >
                              {delta > 0 ? "+" : ""}
                              {formatCurrency(delta)}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                        <div>
                          Basic{" "}
                          <span className="text-foreground">
                            {formatCurrency(r.basic_salary)}
                          </span>
                        </div>
                        <div>
                          Housing{" "}
                          <span className="text-foreground">
                            {formatCurrency(Number(alw.housing_allowance || 0))}
                          </span>
                        </div>
                        <div>
                          Transport{" "}
                          <span className="text-foreground">
                            {formatCurrency(Number(alw.transport_allowance || 0))}
                          </span>
                        </div>
                        <div>
                          Other{" "}
                          <span className="text-foreground">
                            {formatCurrency(Number(alw.other_allowances || 0))}
                          </span>
                        </div>
                      </div>
                      {r.reason && (
                        <p className="mt-2 text-xs italic text-muted-foreground">
                          {r.reason}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
