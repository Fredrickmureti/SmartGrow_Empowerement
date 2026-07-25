/**
 * Payroll Batch Register — read-only reporting surface backed by the
 * `v_payroll_batch_register` view (ADR-0045 §5). One row per child
 * payroll run, joined to its parent batch metadata. Filterable by
 * business + period + status; exportable to CSV.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format, startOfMonth, endOfMonth, addMonths, subMonths } from "date-fns";
import {
  Layers, ChevronLeft, ChevronRight, Download, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { buildCsv, downloadCsv } from "@/lib/exports/csv";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useCurrency } from "@/hooks/useCurrency";

interface RegisterRow {
  batch_id: string | null;
  batch_number: string | null;
  batch_status: string | null;
  batch_run_type: string | null;
  batch_period_start: string | null;
  batch_period_end: string | null;
  run_id: string | null;
  payroll_number: string | null;
  run_status: string | null;
  run_type: string | null;
  pay_period_start: string | null;
  pay_period_end: string | null;
  payment_date: string | null;
  employee_count: number | null;
  total_gross: number | null;
  total_net: number | null;
  total_other_deductions: number | null;
  total_employer_contributions: number | null;
  is_reversal: boolean | null;
}

const STATUS_OPTIONS = ["all", "draft", "computing", "review", "approved", "posted", "paid", "closed", "cancelled", "reversed"];

export default function PayrollBatchRegister() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();

  const [anchor, setAnchor] = useState<Date>(new Date());
  const [showAll, setShowAll] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const periodStart = useMemo(() => startOfMonth(anchor), [anchor]);
  const periodEnd = useMemo(() => endOfMonth(anchor), [anchor]);

  const scopeReady = !!currentOrg?.id && !!currentBusiness?.id;

  const registerQ = useQuery({
    queryKey: ["payroll-batch-register", currentOrg?.id, currentBusiness?.id, format(periodStart, "yyyy-MM-dd"), format(periodEnd, "yyyy-MM-dd"), showAll, statusFilter],
    enabled: scopeReady,
    queryFn: async (): Promise<RegisterRow[]> => {
      let q = supabase
        .from("v_payroll_batch_register")
        .select("*")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .order("batch_period_end", { ascending: false });
      if (!showAll) {
        const s = format(periodStart, "yyyy-MM-dd");
        const e = format(periodEnd, "yyyy-MM-dd");
        q = q.lte("batch_period_start", e).gte("batch_period_end", s);
      }
      if (statusFilter !== "all") q = q.eq("batch_status", statusFilter);
      const { data, error } = await q.limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as RegisterRow[];
    },
  });

  const rows = registerQ.data ?? [];
  const totals = useMemo(() => rows.reduce(
    (acc, r) => ({
      runs: acc.runs + 1,
      employees: acc.employees + (r.employee_count ?? 0),
      gross: acc.gross + Number(r.total_gross ?? 0),
      net: acc.net + Number(r.total_net ?? 0),
      employer: acc.employer + Number(r.total_employer_contributions ?? 0),
    }),
    { runs: 0, employees: 0, gross: 0, net: 0, employer: 0 },
  ), [rows]);

  const downloadCsv = () => {
    const headers = [
      "batch_number", "batch_status", "batch_run_type", "batch_period_start", "batch_period_end",
      "payroll_number", "run_status", "run_type", "pay_period_start", "pay_period_end", "payment_date",
      "employee_count", "total_gross", "total_net", "total_other_deductions", "total_employer_contributions", "is_reversal",
    ];
    downloadCsv(
      `payroll-batch-register-${format(periodStart, "yyyy-MM")}.csv`,
      buildCsv(rows as Record<string, unknown>[], headers),
    );
  };

  if (!scopeReady) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Layers className="h-6 w-6" /> Payroll Batch Register
        </h1>
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
          Select an organisation and business to view the register.
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Layers className="h-6 w-6" /> Payroll Batch Register
          </h1>
          <p className="text-sm text-muted-foreground">
            Per-run register sourced from <code className="text-xs">v_payroll_batch_register</code>.
            Use this for period-end audit reconciliations and pack exports.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/hr/payroll/control-center">
            <Button variant="outline" size="sm"><ExternalLink className="h-3 w-3 mr-1" /> Control Center</Button>
          </Link>
          <Button size="sm" onClick={downloadCsv} disabled={rows.length === 0}>
            <Download className="h-3 w-3 mr-1" /> Export CSV
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border rounded-md p-2 bg-muted/30">
        <Button size="icon" variant="ghost" onClick={() => setAnchor((d) => subMonths(d, 1))} aria-label="Previous month">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="text-sm font-medium min-w-[10ch] text-center">{format(anchor, "MMMM yyyy")}</div>
        <Button size="icon" variant="ghost" onClick={() => setAnchor((d) => addMonths(d, 1))} aria-label="Next month">
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAnchor(new Date())}>This month</Button>
        <label className="flex items-center gap-1 text-xs cursor-pointer ml-2">
          <Checkbox checked={showAll} onCheckedChange={(c) => setShowAll(!!c)} />
          <span>Show all periods</span>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Batch status</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="py-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
            <Stat label="Runs" value={String(totals.runs)} />
            <Stat label="Employees" value={String(totals.employees)} />
            <Stat label="Gross" value={formatCurrency(totals.gross)} />
            <Stat label="Net" value={formatCurrency(totals.net)} />
            <Stat label="Employer" value={formatCurrency(totals.employer)} />
          </div>
        </CardContent>
      </Card>

      {registerQ.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
          No register rows for the current filters.
        </CardContent></Card>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="p-2">Batch</th>
                <th className="p-2">Status</th>
                <th className="p-2">Run</th>
                <th className="p-2">Period</th>
                <th className="p-2 text-right">Emp</th>
                <th className="p-2 text-right">Gross</th>
                <th className="p-2 text-right">Net</th>
                <th className="p-2 text-right">Employer</th>
                <th className="p-2">Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={`${r.batch_id}-${r.run_id}`} className="hover:bg-muted/30">
                  <td className="p-2 font-mono">{r.batch_number ?? "—"}</td>
                  <td className="p-2"><Badge variant="outline" className="text-[10px]">{r.batch_status ?? "—"}</Badge></td>
                  <td className="p-2">
                    {r.run_id ? (
                      <Link to={`/hr/payroll/runs/${r.run_id}`} className="font-mono hover:underline">
                        {r.payroll_number ?? r.run_id.slice(0, 8)}
                      </Link>
                    ) : "—"}
                  </td>
                  <td className="p-2 text-muted-foreground whitespace-nowrap">
                    {r.pay_period_start ? format(new Date(r.pay_period_start), "MMM d") : "—"}
                    {" – "}
                    {r.pay_period_end ? format(new Date(r.pay_period_end), "MMM d, yyyy") : "—"}
                  </td>
                  <td className="p-2 text-right">{r.employee_count ?? 0}</td>
                  <td className="p-2 text-right font-mono">{formatCurrency(Number(r.total_gross ?? 0))}</td>
                  <td className="p-2 text-right font-mono">{formatCurrency(Number(r.total_net ?? 0))}</td>
                  <td className="p-2 text-right font-mono">{formatCurrency(Number(r.total_employer_contributions ?? 0))}</td>
                  <td className="p-2">
                    {r.is_reversal && <Badge variant="destructive" className="text-[10px]">reversal</Badge>}
                    {r.run_type && r.run_type !== "regular" && (
                      <Badge variant="secondary" className="text-[10px] ml-1">{r.run_type}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
