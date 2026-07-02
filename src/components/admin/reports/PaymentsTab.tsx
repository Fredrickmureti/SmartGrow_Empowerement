// @ts-nocheck
import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CreditCard, AlertTriangle, CheckCircle, Clock, XCircle } from "lucide-react";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";

interface PaymentRow {
  id: string;
  org_name: string;
  amount: number;
  currency: string;
  status: string;
  payment_method: string;
  payment_date: string;
  plan_name: string;
}

export function PaymentsTab({ formatCurrency }: { formatCurrency: (v: number) => string }) {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchPayments();
  }, []);

  const fetchPayments = async () => {
    setIsLoading(true);
    try {
      const { data } = await supabase
        .from("subscription_payments")
        .select("id, amount, currency, status, payment_method, payment_date, organization_id")
        .order("payment_date", { ascending: false })
        .limit(200);

      const { data: orgs } = await supabase.from("organizations").select("id, name, subscription_plan_id");
      const { data: plans } = await supabase.from("platform_subscription_plans").select("id, name");

      const orgMap = new Map((orgs || []).map(o => [o.id, o]));
      const planMap = new Map((plans || []).map(p => [p.id, p]));

      setPayments((data || []).map(p => {
        const org = orgMap.get(p.organization_id);
        const plan = org ? planMap.get(org.subscription_plan_id) : null;
        return {
          id: p.id,
          org_name: org?.name || "Unknown",
          amount: Number(p.amount || 0),
          currency: p.currency || "USD", // architecture-allow: display-only fallback
          status: p.status || "unknown",
          payment_method: p.payment_method || "—",
          payment_date: p.payment_date,
          plan_name: plan?.name || "—",
        };
      }));
    } catch (e) {
      console.error("Error fetching payments:", e);
    } finally {
      setIsLoading(false);
    }
  };

  const filtered = statusFilter === "all" ? payments : payments.filter(p => p.status === statusFilter);

  const succeeded = payments.filter(p => p.status === "succeeded" || p.status === "completed").length;
  const failed = payments.filter(p => p.status === "failed").length;
  const pending = payments.filter(p => p.status === "pending").length;
  const totalRevenue = payments.filter(p => p.status === "succeeded" || p.status === "completed").reduce((s, p) => s + p.amount, 0);

  const statusIcon = (s: string) => {
    if (s === "succeeded" || s === "completed") return <CheckCircle className="h-3.5 w-3.5 text-green-600" />;
    if (s === "failed") return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    if (s === "pending") return <Clock className="h-3.5 w-3.5 text-yellow-600" />;
    return <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />;
  };

  const getExportConfig = (): ExportConfig => ({
    title: "Payment History Report",
    columns: [
      { key: "payment_date", header: "Date" },
      { key: "org_name", header: "Organization" },
      { key: "plan_name", header: "Plan" },
      { key: "amount", header: "Amount", format: "currency" },
      { key: "payment_method", header: "Method" },
      { key: "status", header: "Status" },
    ],
    rows: filtered.map(p => ({
      ...p,
      payment_date: p.payment_date ? format(new Date(p.payment_date), "yyyy-MM-dd HH:mm") : "—",
    })),
    generatedAt: new Date(),
  });

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="p-4 pb-2"><CardDescription className="text-xs">Total Revenue</CardDescription></CardHeader>
          <CardContent className="p-4 pt-0"><div className="text-2xl font-bold text-green-600">{formatCurrency(totalRevenue)}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="p-4 pb-2"><CardDescription className="text-xs">Successful</CardDescription></CardHeader>
          <CardContent className="p-4 pt-0"><div className="text-2xl font-bold text-green-600">{succeeded}</div></CardContent>
        </Card>
        <Card className={failed > 0 ? "border-destructive/30 bg-destructive/5" : ""}>
          <CardHeader className="p-4 pb-2"><CardDescription className="text-xs">Failed</CardDescription></CardHeader>
          <CardContent className="p-4 pt-0"><div className={`text-2xl font-bold ${failed > 0 ? "text-destructive" : ""}`}>{failed}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="p-4 pb-2"><CardDescription className="text-xs">Pending</CardDescription></CardHeader>
          <CardContent className="p-4 pt-0"><div className="text-2xl font-bold text-yellow-600">{pending}</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="p-4 sm:p-6">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                <CreditCard className="h-4 w-4" /> Payment History
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm">All subscription payments</CardDescription>
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="succeeded">Succeeded</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="refunded">Refunded</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <div className="px-4 sm:px-6 pb-2 flex justify-end">
          <ReportExportButtons getExportConfig={getExportConfig} formats={["excel", "csv", "pdf"]} compact />
        </div>
        <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No payments found</TableCell></TableRow>
                ) : (
                  filtered.slice(0, 100).map(p => (
                    <TableRow key={p.id}>
                      <TableCell className="text-xs">{p.payment_date ? format(new Date(p.payment_date), "MMM d, yyyy") : "—"}</TableCell>
                      <TableCell className="font-medium">{p.org_name}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{p.plan_name}</Badge></TableCell>
                      <TableCell className="text-right font-medium">{formatCurrency(p.amount)}</TableCell>
                      <TableCell className="text-xs capitalize">{p.payment_method}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {statusIcon(p.status)}
                          <span className="text-xs capitalize">{p.status}</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
