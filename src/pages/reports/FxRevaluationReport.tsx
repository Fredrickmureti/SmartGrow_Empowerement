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
 *
 * Rendered by the canonical reporting engine (`@/design-system/reports`).
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
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import type {
  ExportConfig, ExportColumn, ExportRow,
} from "@/services/reports/ReportExportService";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";

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

function FxRevaluationReportInner() {
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

  const columns = useMemo<ReportColumn[]>(
    () => [
      {
        key: "run_date",
        header: "Run date",
        width: "w-[130px]",
        render: (row) => {
          const raw = row.values?.run_date == null ? "" : String(row.values.run_date);
          // Expanded child rows reuse this column for labels (currency,
          // "Notes: …"), so never coerce them through a date parser.
          const isDetail = row.kind === "detail" || (row.depth ?? 0) > 0;
          if (isDetail) {
            return <span className="text-xs text-muted-foreground">{raw || "—"}</span>;
          }
          const parsed = raw ? new Date(raw) : null;
          const label = parsed && isValid(parsed) ? format(parsed, "yyyy-MM-dd") : raw || "—";
          return (
            <button
              type="button"
              className="flex items-center gap-1.5 text-left"
              onClick={(e) => { e.stopPropagation(); toggle(row.id); }}
            >
              {expanded[row.id] ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <span className="font-mono text-xs">{label}</span>
            </button>
          );
        },

      },
      {
        key: "status",
        header: "Status",
        width: "w-[110px]",
        render: (row) => (
          <Badge variant={STATUS_VARIANT[String(row.values?.status)] ?? "outline"}>
            {String(row.values?.status)}
          </Badge>
        ),
      },
      { key: "currencies", header: "Currencies", width: "w-[160px]" },
      { key: "line_count", header: "Accounts", format: "number", width: "w-[100px]" },
      { key: "gain", header: "Gain", format: "currency", width: "w-[140px]" },
      { key: "loss", header: "Loss", format: "currency", width: "w-[140px]" },
      {
        key: "net",
        header: "Net",
        format: "currency",
        width: "w-[140px]",
      },
      {
        key: "je",
        header: "Journal entry",
        width: "w-[160px]",
        exportExclude: true,
        render: (row) => {
          const jeId = row.values?.je as string | null;
          return jeId ? (
            <Button asChild variant="outline" size="sm">
              <Link to={`/finance/journal-entries/${jeId}`}>
                View JE <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          );
        },
      },
    ],
    [expanded],
  );

  const tableRows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    rows.forEach((r) => {
      out.push({
        id: r.id,
        tone: r.status === "reversed" ? "warning" : "default",
        values: {
          run_date: r.run_date,
          status: r.status,
          currencies: r.currencies.join(", ") || null,
          line_count: r.line_count,
          gain: r.total_unrealized_gain,
          loss: r.total_unrealized_loss,
          net: r.net_impact,
          je: r.journal_entry_id,
        },
      });
      if (expanded[r.id]) {
        if (r.lines.length === 0) {
          out.push({
            id: `${r.id}-empty`,
            kind: "detail",
            values: { run_date: "No line detail." },
          });
        } else {
          r.lines.forEach((l) => {
            out.push({
              id: `${r.id}-${l.id}`,
              depth: 1,
              tone: l.delta < 0 ? "danger" : "success",
              values: {
                run_date: l.currency,
                status: null,
                currencies: `Acct ${l.account_id.slice(0, 8)}…`,
                line_count: null,
                gain: null,
                loss: null,
                net: l.delta,
                je: null,
              },
            });
          });
        }
        if (r.notes) {
          out.push({
            id: `${r.id}-notes`,
            depth: 1,
            values: { run_date: `Notes: ${r.notes}` },
          });
        }
      }
    });
    return out;
  }, [rows, expanded]);

  const getExportConfig = useCallback((): ExportConfig => {
    const exportColumns: ExportColumn[] = [
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
      // No registry entry (bespoke schedule) — declare the statement masthead.
      formatProfile: "financial",
      columns: exportColumns, rows: exportRows, currency: baseCurrency,
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

        <ReportSurface
          title="FX Revaluation Runs"
          profile="operational"
        >
          <ReportTable
            columns={columns}
            rows={tableRows}
            currency={baseCurrency}
            caption="FX revaluation runs with currency mix and gain/loss totals"
            emptyMessage="No FX revaluation runs match the selected filters."
          />
        </ReportSurface>
      </div>
    </ReportPageLayout>
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

import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

export default function FxRevaluationReport() {
  return (
    <ReportFilterProvider>
      <FxRevaluationReportInner />
    </ReportFilterProvider>
  );
}
