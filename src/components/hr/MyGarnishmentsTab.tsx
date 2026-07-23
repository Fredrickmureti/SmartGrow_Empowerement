/**
 * MyGarnishmentsTab — Employee-facing view of their own legal orders.
 *
 * Reads from the `public.legal_orders` view (RLS enforced on the underlying
 * `legal_orders_records` table) plus `garnishment_ledger` (payslip_lines
 * SSOT). Employees see only their own rows; HR-only fields are omitted.
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { format } from "date-fns";
import { Loader2, Scale } from "lucide-react";

interface OrderRow {
  id: string;
  kind: string;
  case_reference: string | null;
  authority_name: string | null;
  status: string;
  start_date: string;
  end_date: string | null;
  total_owed: number | null;
  total_paid: number;
}

interface LedgerRow {
  garnishment_id: string;
  payment_date: string | null;
  pay_period_start: string;
  pay_period_end: string;
  amount: number;
}

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  suspended: "secondary",
  satisfied: "outline",
  released: "outline",
  expired: "outline",
};

export function MyGarnishmentsTab({ employeeId }: { employeeId: string }) {
  const { formatCurrency } = useCurrency();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!employeeId) return;
    setLoading(true);
    (async () => {
      const { data: ord } = await supabase
        .from("employee_garnishments")
        .select("id, kind, case_reference, issuing_authority, status, start_date, end_date, total_owed, total_paid")
        .eq("employee_id", employeeId)
        .order("priority", { ascending: true });
      setOrders((ord ?? []) as OrderRow[]);

      const ids = (ord ?? []).map((o: { id: string }) => o.id);
      if (ids.length) {
        const { data: led } = await supabase
          .from("garnishment_ledger")
          .select("garnishment_id, payment_date, pay_period_start, pay_period_end, amount")
          .in("garnishment_id", ids)
          .order("payment_date", { ascending: false })
          .limit(50);
        setLedger((led ?? []) as LedgerRow[]);
      } else {
        setLedger([]);
      }
      setLoading(false);
    })();
  }, [employeeId]);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!orders.length) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          <Scale className="h-8 w-8 mx-auto mb-3 opacity-40" />
          You have no garnishment orders on file.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>My Garnishment Orders</CardTitle>
          <CardDescription>
            Court-ordered or statutory deductions applied to your pay. Contact HR if any detail looks incorrect.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Issuing authority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Owed</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => {
                const remaining = o.total_owed != null ? Math.max(0, Number(o.total_owed) - Number(o.total_paid)) : null;
                return (
                  <TableRow key={o.id}>
                    <TableCell className="capitalize">{o.kind.replace(/_/g, " ")}</TableCell>
                    <TableCell>{o.case_reference ?? "—"}</TableCell>
                    <TableCell>{o.issuing_authority ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_TONE[o.status] ?? "outline"} className="capitalize">{o.status}</Badge>
                    </TableCell>
                    <TableCell>{format(new Date(o.start_date), "MMM d, yyyy")}</TableCell>
                    <TableCell className="text-right">{o.total_owed != null ? formatCurrency(Number(o.total_owed)) : "—"}</TableCell>
                    <TableCell className="text-right">{formatCurrency(Number(o.total_paid))}</TableCell>
                    <TableCell className="text-right">{remaining != null ? formatCurrency(remaining) : "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Deductions</CardTitle>
          <CardDescription>Last 50 garnishment payments deducted from your payroll.</CardDescription>
        </CardHeader>
        <CardContent>
          {ledger.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No deductions posted yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pay period</TableHead>
                  <TableHead>Payment date</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.map((l, idx) => {
                  const ord = orders.find(o => o.id === l.garnishment_id);
                  return (
                    <TableRow key={`${l.garnishment_id}-${idx}`}>
                      <TableCell>
                        {format(new Date(l.pay_period_start), "MMM d")} – {format(new Date(l.pay_period_end), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>{l.payment_date ? format(new Date(l.payment_date), "MMM d, yyyy") : "—"}</TableCell>
                      <TableCell className="capitalize">{ord ? ord.kind.replace(/_/g, " ") : "—"}</TableCell>
                      <TableCell className="text-right font-medium">{formatCurrency(Number(l.amount))}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
