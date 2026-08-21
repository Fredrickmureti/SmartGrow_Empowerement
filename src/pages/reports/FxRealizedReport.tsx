/**
 * Realized FX Gain/Loss Report — Step 4 of the Currency & FX programme
 * (ADR 0136 / ADR 0138).
 *
 * Where FX Exposure answers "what is at risk", this answers "what did movement
 * in rates actually cost or earn us". Every row is a settlement journal entry
 * that hit the realized FX gain/loss accounts: the currency settled, the rate
 * the document was booked at, the rate it settled at, and the difference that
 * was posted.
 *
 * Read-only projection over `public.fx_realized_gain_loss`. The browser
 * resolves no rate and computes no posted amount, so the report and the general
 * ledger can never disagree.
 *
 * Scoping: org + business — realized FX belongs to the legal entity, exactly as
 * revaluation and exposure do.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import type {
  ExportConfig, ExportColumn, ExportRow,
} from "@/services/reports/ReportExportService";
import { useFxRealizedGainLoss } from "@/hooks/finance/useFxRealized";

const today = () => new Date().toISOString().split("T")[0];
const startOfYear = () => `${new Date().getFullYear()}-01-01`;

function fmtMoney(n: number | null | undefined, ccy: string) {
  if (n === null || n === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: ccy, maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

function fmtRate(n: number | null | undefined) {
  return n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

const SOURCE_LABEL: Record<string, string> = {
  payment: "Customer receipt",
  bill_payment: "Supplier payment",
  bank_reconciliation: "Bank match",
  credit_application: "Credit applied",
};

function FxRealizedReportInner() {
  const [from, setFrom] = useState<string>(startOfYear());
  const [to, setTo] = useState<string>(today());

  const { data, isLoading, error } = useFxRealizedGainLoss(from, to);

  const base = data?.base_currency ?? "";
  const settlements = useMemo(() => data?.settlements ?? [], [data]);
  const byCurrency = useMemo(() => data?.by_currency ?? [], [data]);
  const unconfigured = data ? data.accounts_configured === false : false;

  const currencyColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "currency", header: "Currency", width: "w-[110px]" },
      { key: "settlement_count", header: "Settlements", format: "number", width: "w-[120px]" },
      { key: "gain", header: "Realized gain", format: "currency", width: "w-[160px]" },
      { key: "loss", header: "Realized loss", format: "currency", width: "w-[160px]" },
      { key: "net", header: "Net", format: "currency", width: "w-[160px]" },
    ],
    [],
  );

  const currencyRows = useMemo<ReportRow[]>(
    () =>
      byCurrency.map((c) => ({
        id: c.currency,
        tone: c.net < 0 ? "danger" : "default",
        values: {
          currency: c.currency,
          settlement_count: c.settlement_count,
          gain: c.gain,
          loss: c.loss,
          net: c.net,
        },
      })),
    [byCurrency],
  );

  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "entry_date", header: "Date", width: "w-[110px]" },
      {
        key: "entry_number",
        header: "Entry",
        width: "w-[150px]",
        render: (row) => {
          const id = row.values?.journal_entry_id as string | null;
          const label = String(row.values?.entry_number ?? "—");
          return id ? (
            <Button asChild variant="link" size="sm" className="h-auto p-0">
              <Link to={`/finance/journal-entries/${id}`}>
                {label} <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">{label}</span>
          );
        },
      },
      { key: "source", header: "Settlement", width: "w-[150px]" },
      { key: "party_name", header: "Party", width: "w-[200px]" },
      { key: "currency", header: "Ccy", width: "w-[80px]" },
      { key: "settled_foreign_amount", header: "Settled amount", format: "number", width: "w-[140px]" },
      {
        key: "booked_rate",
        header: "Booked rate",
        width: "w-[120px]",
        render: (row) => (
          <span className="font-mono text-xs">{fmtRate(row.values?.booked_rate as number | null)}</span>
        ),
      },
      {
        key: "settlement_rate",
        header: "Settlement rate",
        width: "w-[130px]",
        render: (row) => (
          <span className="font-mono text-xs">
            {fmtRate(row.values?.settlement_rate as number | null)}
          </span>
        ),
      },
      { key: "booked_base_amount", header: "Booked base", format: "currency", width: "w-[150px]" },
      {
        key: "realized_amount",
        header: "Realized",
        width: "w-[150px]",
        render: (row) => {
          const v = Number(row.values?.realized_amount ?? 0);
          return (
            <div className="flex items-center justify-end gap-2">
              <Badge variant={v < 0 ? "destructive" : "secondary"}>
                {v < 0 ? "Loss" : "Gain"}
              </Badge>
              <span className={`tabular-nums ${v < 0 ? "text-destructive" : ""}`}>
                {fmtMoney(v, base)}
              </span>
            </div>
          );
        },
      },
    ],
    [base],
  );

  const rows = useMemo<ReportRow[]>(
    () =>
      settlements.map((s) => ({
        id: s.journal_entry_id,
        tone: s.realized_amount < 0 ? "danger" : "default",
        values: {
          entry_date: s.entry_date,
          entry_number: s.entry_number ?? "—",
          journal_entry_id: s.journal_entry_id,
          source: SOURCE_LABEL[s.source_type ?? ""] ?? (s.source_type ?? "—"),
          party_name: s.party_name ?? "—",
          currency: s.currency,
          settled_foreign_amount: s.settled_foreign_amount,
          booked_rate: s.booked_rate,
          settlement_rate: s.settlement_rate,
          booked_base_amount: s.booked_base_amount,
          realized_amount: s.realized_amount,
        },
      })),
    [settlements],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    const exportColumns: ExportColumn[] = [
      { key: "entry_date", header: "Date", width: 14 },
      { key: "entry_number", header: "Entry", width: 18 },
      { key: "source", header: "Settlement", width: 18 },
      { key: "party_name", header: "Party", width: 26 },
      { key: "currency", header: "Currency", width: 10 },
      { key: "settled_foreign_amount", header: "Settled amount", width: 18, align: "right" },
      { key: "booked_rate", header: "Booked rate", width: 14, align: "right" },
      { key: "settlement_rate", header: "Settlement rate", width: 16, align: "right" },
      { key: "booked_base_amount", header: "Booked base", width: 18, format: "currency", align: "right" },
      { key: "realized_amount", header: "Realized", width: 18, format: "currency", align: "right" },
    ];
    const exportRows: ExportRow[] = settlements.map((s) => ({
      entry_date: s.entry_date,
      entry_number: s.entry_number ?? "",
      source: SOURCE_LABEL[s.source_type ?? ""] ?? (s.source_type ?? ""),
      party_name: s.party_name ?? "",
      currency: s.currency,
      settled_foreign_amount: s.settled_foreign_amount ?? "",
      booked_rate: s.booked_rate ?? "",
      settlement_rate: s.settlement_rate ?? "",
      booked_base_amount: s.booked_base_amount,
      realized_amount: s.realized_amount,
    }));
    return {
      title: "Realized FX Gain/Loss",
      subtitle: `Settlements between ${from} and ${to}`,
      formatProfile: "financial",
      columns: exportColumns,
      rows: exportRows,
      currency: base,
    };
  }, [settlements, from, to, base]);

  return (
    <ReportPageLayout
      title="Realized FX Gain/Loss"
      description="Foreign-exchange gains and losses actually posted when documents were settled: the rate each document was booked at, the rate it settled at, and the difference recognised in the ledger. Reported at the legal-entity level."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && settlements.length === 0 && !unconfigured}
      emptyMessage="No settlements produced a realized FX gain or loss in this period."
      getExportConfig={getExportConfig}
      filters={
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {unconfigured && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Realized FX accounts are not configured</AlertTitle>
            <AlertDescription>
              Map the realized FX gain and loss accounts under Settings → Default Accounts.
              Until then, settlements of foreign-currency documents have nowhere to recognise
              the difference between the booking rate and the settlement rate.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard label="Settlements with FX" value={String(settlements.length)} />
          <KpiCard label="Realized gain" value={fmtMoney(data?.total_gain ?? 0, base)} />
          <KpiCard
            label="Realized loss"
            value={fmtMoney(data?.total_loss ?? 0, base)}
            tone={(data?.total_loss ?? 0) > 0 ? "negative" : "neutral"}
          />
          <KpiCard
            label="Net realized"
            value={fmtMoney(data?.net_realized ?? 0, base)}
            tone={(data?.net_realized ?? 0) < 0 ? "negative" : "neutral"}
          />
        </div>

        <ReportSurface
          title="By currency"
          profile="operational"
          asOfDate={`${from} → ${to}`}
        >
          <ReportTable
            columns={currencyColumns}
            rows={currencyRows}
            currency={base}
            caption="Realized gain and loss recognised per settlement currency"
            emptyMessage="No realized FX in this period."
          />
        </ReportSurface>

        <ReportSurface
          title="Settlements"
          profile="operational"
          asOfDate={`${from} → ${to}`}
        >
          <ReportTable
            columns={columns}
            rows={rows}
            currency={base}
            caption="Each settlement entry that recognised a realized FX difference, linked to its journal entry"
            emptyMessage="No settlements produced a realized FX gain or loss in this period."
          />
        </ReportSurface>
      </div>
    </ReportPageLayout>
  );
}

export default function FxRealizedReport() {
  return (
    <ReportFilterProvider>
      <FxRealizedReportInner />
    </ReportFilterProvider>
  );
}

function KpiCard({
  label, value, tone = "neutral",
}: { label: string; value: string; tone?: "neutral" | "negative" }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={`text-lg font-semibold tabular-nums ${tone === "negative" ? "text-destructive" : ""}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
