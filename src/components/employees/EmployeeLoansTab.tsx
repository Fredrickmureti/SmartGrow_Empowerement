/**
 * Employee Loans tab — shows all loans (any status) attached to the employee
 * with quick visual status, outstanding balance and a link to the full
 * loan management page for HR actions.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrency } from "@/hooks/useCurrency";
import { ExternalLink, Wallet } from "lucide-react";
import { format } from "date-fns";

interface Row {
  id: string;
  loan_number: string;
  loan_type: string;
  principal_amount: number;
  outstanding_balance: number;
  monthly_deduction: number;
  installments_paid: number;
  total_installments: number;
  status: string;
  start_date: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  completed: "secondary",
  suspended: "outline",
  pending_approval: "outline",
  requested: "outline",
  rejected: "destructive",
  cancelled: "secondary",
  draft: "secondary",
};

export function EmployeeLoansTab({ employeeId }: { employeeId: string }) {
  const { formatCurrency } = useCurrency();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("employee_loans")
        .select(
          "id,loan_number,loan_type,principal_amount,outstanding_balance,monthly_deduction,installments_paid,total_installments,status,start_date",
        )
        .eq("employee_id", employeeId)
        .order("created_at", { ascending: false });
      if (active) {
        setRows((data ?? []) as Row[]);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [employeeId]);

  const totalOutstanding = rows
    .filter((r) => r.status === "active" || r.status === "suspended")
    .reduce((sum, r) => sum + Number(r.outstanding_balance || 0), 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4" /> Loans & Advances
          </CardTitle>
          {!loading && (
            <p className="text-xs text-muted-foreground mt-1">
              {rows.length} record(s) · Outstanding{" "}
              <strong>{formatCurrency(totalOutstanding)}</strong>
            </p>
          )}
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/hr/loans">
            Manage <ExternalLink className="ml-1 h-3 w-3" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No loans on record.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.loan_number}</span>
                    <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>
                      {r.status.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {r.loan_type} · started {format(new Date(r.start_date), "MMM d, yyyy")} ·{" "}
                    {r.installments_paid}/{r.total_installments} installments
                  </p>
                </div>
                <div className="text-right text-sm">
                  <div>
                    Principal{" "}
                    <span className="font-medium">{formatCurrency(r.principal_amount)}</span>
                  </div>
                  <div className="text-muted-foreground">
                    Outstanding{" "}
                    <span
                      className={
                        Number(r.outstanding_balance) > 0
                          ? "font-medium text-destructive"
                          : "font-medium text-foreground"
                      }
                    >
                      {formatCurrency(r.outstanding_balance)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
