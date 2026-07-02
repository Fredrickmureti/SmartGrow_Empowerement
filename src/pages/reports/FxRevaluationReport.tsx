/**
 * FX Revaluation Report — Phase B6
 *
 * Read-only report over `fx_revaluation_runs` + `fx_revaluation_lines`.
 * Each run re-prices foreign-currency monetary balances at a closing
 * rate and posts the unrealized gain/loss to the GL. This page surfaces
 * every run with its currency mix, gain/loss totals, and a drill into
 * the line-level before/after picture plus the posted journal entry.
 *
 * Scoping: org + business always. Branch is NOT applicable — FX
 * revaluation reprices assets/liabilities of the legal entity as a
 * whole (see `entityOnlyReason("fx_revaluation")`). The page therefore
 * does NOT consume `useFinanceScope().branchId`.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import type {
  ExportConfig, ExportColumn, ExportRow,
} from "@/services/reports/ReportExportService";

type StatusFilter = "all" | "draft" | "posted" | "reversed" | "cancelled";

interface FxLine {
  id: string;
  account_id: string;
  currency: string;
  foreign_balance: number;
  old_rate: number;
  new_rate: number;
  base_balance_old: number;
  base_balance_new: number;
  delta: number;
}

interface FxRunRow {
  id: string;
  run_date: string;
  base_currency: string;
  status: string;
  total_unrealized_gain: number;
  total_unrealized_loss: number;
  net_impact: number;
  journal_entry_id: string | null;
  reversal_journal_entry_id: string | null;
  notes: string | null;
  currencies: string[];
  line_count: number;
  lines: FxLine[];
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  posted: "default",
  reversed: "destructive",
  cancelled: "outline",
};

function fmtMoney(n: number, ccy: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: ccy, maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

export default function FxRevaluationReport() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { baseCurrency } = useCurrency();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [currency, setCurrency] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: [
      "fx-revaluation-report",
      currentOrg?.id, currentBusiness?.id,
      status, currency, fromDate, toDate,
    ],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<FxRunRow[]> => {
      let q = supabase
        .from("fx_revaluation_runs")
        .select(`
          id, run_date, base_currency, status,
          total_unrealized_gain, total_unrealized_loss,
          journal_entry_id, reversal_journal_entry_id, notes,
          lines:fx_revaluation_lines (
            id, account_id, currency,
            foreign_balance, old_rate, new_rate,
            base_balance_old, base_balance_new, delta
          )
        `)
        .eq("organization_id", currentOrg!.id)
        .order("run_date", { ascending: false });
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      if (status !== "all") q = q.eq("status", status);
      if (fromDate) q = q.gte("run_date", fromDate);
      if (toDate) q = q.lte("run_date", toDate);
      const { data, error } = await q;
      if (error) throw error;
      const raw = (data ?? []).map((r: Record<string, unknown>) => {
        const lines = ((r.lines as Array<Record<string, unknown>> | null) ?? []).map((l) => ({
          id: l.id as string,
          account_id: l.account_id as string,
          currency: l.currency as string,
          foreign_balance: Number(l.foreign_balance ?? 0),
          old_rate: Number(l.old_rate ?? 0),
          new_rate: Number(l.new_rate ?? 0),
          base_balance_old: Number(l.base_balance_old ?? 0),
          base_balance_new: Number(l.base_balance_new ?? 0),
          delta: Number(l.delta ?? 0),
        }));
        const gain = Number(r.total_unrealized_gain ?? 0);
        const loss = Number(r.total_unrealized_loss ?? 0);
        return {
          id: r.id as string,
          run_date: r.run_date as string,
          base_currency: (r.base_currency as string) ?? baseCurrency,
          status: (r.status as string) ?? "draft",
          total_unrealized_gain: gain,
          total_unrealized_loss: loss,
          net_impact: gain - loss,
          journal_entry_id: (r.journal_entry_id as string | null) ?? null,
          reversal_journal_entry_id: (r.reversal_journal_entry_id as string | null) ?? null,
          notes: (r.notes as string | null) ?? null,
          currencies: Array.from(new Set(lines.map((l) => l.currency))).sort(),
          line_count: lines.length,
          lines,
        } satisfies FxRunRow;
      });
      if (currency === "all") return raw;
      // currency filter is applied client-side over the line currencies, so
      // KPIs reflect runs that actually touched the selected currency.
      return raw.filter((r) => r.currencies.includes(currency));
    },
  });

  const currencies = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.currencies.forEach((c) => s.add(c)));
    return Array.from(s).sort();
  }, [rows]);

  const kpis = useMemo(() => {
    const posted = rows.filter((r) => r.status === "posted");
    let accounts = 0;
    posted.forEach((r) => { accounts += r.line_count; });
    return {
      total: rows.length,
      gain: posted.reduce((a, r) => a + r.total_unrealized_gain, 0),
      loss: posted.reduce((a, r) => a + r.total_unrealized_loss, 0),
      net: posted.reduce((a, r) => a + r.net_impact, 0),
      accounts,
    };
  }, [rows]);

  const toggle = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "run_date", header: "Run date", width: 14 },
      { key: "status", header: "Status", width: 12 },
      { key: "currencies", header: "Currencies", width: 22 },
      { key: "line_count", header: "Accounts", width: 12, align: "right" },
      { key: "gain", header: "Unrealized gain", width: 18, format: "currency", align: "right" },
      { key: "loss", header: "Unrealized loss", width: 18, format: "currency", align: "right" },
      { key: "net", header: "Net impact", width: 18, format: "currency", align: "right" },
      { key: "je", header: "Journal entry", width: 18 },
    ];
    const exportRows: ExportRow[] = rows.map((r) => ({
      run_date: r.run_date ? format(new Date(r.run_date), "yyyy-MM-dd") : "",
      status: r.status,
      currencies: r.currencies.join(", "),
      line_count: r.line_count,
      gain: r.total_unrealized_gain,
      loss: r.total_unrealized_loss,
      net: r.net_impact,
      je: r.journal_entry_id ?? "",
    }));
    return {
      title: "FX Revaluation Report",
      subtitle: "Unrealized gain/loss on foreign-currency monetary balances",
      columns, rows: exportRows, currency: baseCurrency,
    };
  }, [rows, baseCurrency]);

  return (
    <ReportPageLayout
      title="FX Revaluation Report"
      description="Foreign-currency revaluation runs with per-account before/after balances and the unrealized gain/loss posted to the GL. Reported at the legal-entity level — assets and liabilities are not branch-owned."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No FX revaluation runs match the selected filters."
      getExportConfig={getExportConfig}
      filters={
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="posted">Posted</SelectItem>
                <SelectItem value="reversed">Reversed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Currency</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All currencies</SelectItem>
                {currencies.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">From</Label>
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <KpiCard label="Runs" value={String(kpis.total)} />
          <KpiCard label="Accounts revalued (posted)" value={String(kpis.accounts)} />
          <KpiCard label="Σ unrealized gain" value={fmtMoney(kpis.gain, baseCurrency)} />
          <KpiCard label="Σ unrealized loss" value={fmtMoney(kpis.loss, baseCurrency)} />
          <KpiCard
            label="Net impact"
            value={fmtMoney(kpis.net, baseCurrency)}
            tone={kpis.net < 0 ? "negative" : "neutral"}
          />
        </div>

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px]"></TableHead>
                  <TableHead>Run date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Currencies</TableHead>
                  <TableHead className="text-right">Accounts</TableHead>
                  <TableHead className="text-right">Gain</TableHead>
                  <TableHead className="text-right">Loss</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="w-[160px]">Journal entry</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <FxRow
                    key={r.id}
                    row={r}
                    baseCurrency={baseCurrency}
                    expanded={!!expanded[r.id]}
                    onToggle={() => toggle(r.id)}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </ReportPageLayout>
  );
}

function FxRow({
  row, baseCurrency, expanded, onToggle,
}: {
  row: FxRunRow;
  baseCurrency: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow className={row.status === "reversed" ? "bg-amber-50/40 dark:bg-amber-950/10" : ""}>
        <TableCell>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggle} aria-label="Toggle details">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </TableCell>
        <TableCell className="font-mono text-xs">
          {row.run_date ? format(new Date(row.run_date), "yyyy-MM-dd") : "—"}
        </TableCell>
        <TableCell>
          <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>{row.status}</Badge>
        </TableCell>
        <TableCell className="text-sm">{row.currencies.join(", ") || "—"}</TableCell>
        <TableCell className="text-right tabular-nums">{row.line_count}</TableCell>
        <TableCell className="text-right tabular-nums text-emerald-700">
          {fmtMoney(row.total_unrealized_gain, baseCurrency)}
        </TableCell>
        <TableCell className="text-right tabular-nums text-rose-700">
          {fmtMoney(row.total_unrealized_loss, baseCurrency)}
        </TableCell>
        <TableCell className={`text-right tabular-nums ${row.net_impact < 0 ? "text-rose-700" : "text-emerald-700"}`}>
          {fmtMoney(row.net_impact, baseCurrency)}
        </TableCell>
        <TableCell>
          {row.journal_entry_id ? (
            <Button asChild variant="outline" size="sm">
              <Link to={`/finance/journal-entries/${row.journal_entry_id}`}>
                View JE <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/30">
          <TableCell colSpan={9} className="p-3">
            {row.lines.length === 0 ? (
              <div className="text-xs text-muted-foreground">No line detail.</div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead>CCY</TableHead>
                      <TableHead className="text-right">Foreign balance</TableHead>
                      <TableHead className="text-right">Old rate</TableHead>
                      <TableHead className="text-right">New rate</TableHead>
                      <TableHead className="text-right">Base (old)</TableHead>
                      <TableHead className="text-right">Base (new)</TableHead>
                      <TableHead className="text-right">Δ</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {row.lines.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="font-mono text-xs">
                          <Link className="hover:underline" to={`/finance/accounts/${l.account_id}`}>
                            {l.account_id.slice(0, 8)}…
                          </Link>
                        </TableCell>
                        <TableCell>{l.currency}</TableCell>
                        <TableCell className="text-right tabular-nums">{l.foreign_balance.toFixed(2)}</TableCell>
                        <TableCell className="text-right tabular-nums">{l.old_rate.toFixed(6)}</TableCell>
                        <TableCell className="text-right tabular-nums">{l.new_rate.toFixed(6)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMoney(l.base_balance_old, row.base_currency)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMoney(l.base_balance_new, row.base_currency)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${l.delta < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                          {fmtMoney(l.delta, row.base_currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {row.notes && (
              <div className="mt-2 text-xs text-muted-foreground">
                <span className="font-medium">Notes:</span> {row.notes}
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function KpiCard({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "negative" }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold tabular-nums ${tone === "negative" ? "text-rose-700" : ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
