/**
 * FX Exposure Report — Step G of the Currency & FX convergence (ADR 0136).
 *
 * What a controller needs BEFORE running a period-end revaluation: which
 * foreign currencies the entity is open in, split across receivables, payables,
 * cash & bank and other monetary accounts; what those balances are already
 * booked at; the rate the resolver would use as of the report date and where
 * that rate came from; and the unrealized difference that a revaluation would
 * post today.
 *
 * Read-only projection. Every figure comes from
 * `public.fx_exposure_by_currency` / `public.fx_exposure_open_items`, which
 * resolve rates server-side through `resolve_exchange_rate` over the same
 * open-balance scope as `revalue_fx_balances`. The browser computes no rate and
 * no posted amount. A currency with no rate on file renders as "—" with an
 * explicit "no rate on file" state — never a silent 1:1.
 *
 * Scoping: org + business. Branch is not applicable — FX exposure belongs to
 * the legal entity, exactly as revaluation does.
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
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import type {
  ExportConfig, ExportColumn, ExportRow,
} from "@/services/reports/ReportExportService";
import {
  useFxExposure,
  useFxExposureOpenItems,
  type FxExposureCurrency,
} from "@/hooks/finance/useFxExposure";

const today = () => new Date().toISOString().split("T")[0];

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
  return n === null || n === undefined ? "—" : Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 6,
  });
}

function provenance(row: {
  rate: number | null;
  rate_source: string | null;
  rate_provider_key: string | null;
  rate_effective_date: string | null;
}) {
  if (row.rate === null) return "no rate on file";
  const bits = [row.rate_source ?? "provider"];
  if (row.rate_provider_key) bits.push(row.rate_provider_key);
  if (row.rate_effective_date) bits.push(`eff. ${row.rate_effective_date}`);
  return bits.join(" · ");
}

export default function FxExposureReport() {
  const [asOf, setAsOf] = useState<string>(today());
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading, error } = useFxExposure(asOf);
  const { data: drill, isLoading: drillLoading } = useFxExposureOpenItems(selected, asOf);

  const base = data?.base_currency ?? "";
  const currencies = useMemo<FxExposureCurrency[]>(() => data?.currencies ?? [], [data]);
  const missing = data?.missing_rates ?? [];

  const kpis = useMemo(() => {
    let booked = 0;
    let revalued = 0;
    let diff = 0;
    let unpriced = 0;
    for (const c of currencies) {
      booked += c.booked_base_amount;
      if (c.revalued_base_amount === null) unpriced += 1;
      else {
        revalued += c.revalued_base_amount;
        diff += c.unrealized_difference ?? 0;
      }
    }
    return { booked, revalued, diff, unpriced, count: currencies.length };
  }, [currencies]);

  const columns = useMemo<ReportColumn[]>(
    () => [
      {
        key: "currency",
        header: "Currency",
        width: "w-[110px]",
        render: (row) => (
          <button
            type="button"
            className="font-mono text-xs underline-offset-2 hover:underline"
            onClick={() => setSelected(String(row.values?.currency))}
          >
            {String(row.values?.currency ?? "—")}
          </button>
        ),
      },
      { key: "receivable", header: "Receivables", format: "number", width: "w-[130px]" },
      { key: "payable", header: "Payables", format: "number", width: "w-[130px]" },
      { key: "cash_bank", header: "Cash & bank", format: "number", width: "w-[130px]" },
      { key: "other", header: "Other", format: "number", width: "w-[110px]" },
      { key: "foreign_balance", header: "Net exposure", format: "number", width: "w-[140px]" },
      {
        key: "rate",
        header: "Rate used",
        width: "w-[190px]",
        render: (row) => {
          const rate = row.values?.rate as number | null;
          return rate === null || rate === undefined ? (
            <Badge variant="destructive">No rate on file</Badge>
          ) : (
            <div className="leading-tight">
              <div className="font-mono text-xs">{fmtRate(rate)}</div>
              <div className="text-[11px] text-muted-foreground">
                {String(row.values?.provenance ?? "")}
              </div>
            </div>
          );
        },
      },
      { key: "booked", header: "Booked base", format: "currency", width: "w-[150px]" },
      { key: "revalued", header: "Revalued base", format: "currency", width: "w-[150px]" },
      { key: "difference", header: "Unrealized", format: "currency", width: "w-[150px]" },
    ],
    [],
  );

  const tableRows = useMemo<ReportRow[]>(
    () =>
      currencies.map((c) => ({
        id: c.currency,
        tone: c.rate === null ? "warning" : (c.unrealized_difference ?? 0) < 0 ? "danger" : "default",
        values: {
          currency: c.currency,
          receivable: c.receivable,
          payable: c.payable,
          cash_bank: c.cash_bank,
          other: c.other,
          foreign_balance: c.foreign_balance,
          rate: c.rate,
          provenance: provenance(c),
          booked: c.booked_base_amount,
          revalued: c.revalued_base_amount,
          difference: c.unrealized_difference,
        },
      })),
    [currencies],
  );

  const drillColumns = useMemo<ReportColumn[]>(
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
      { key: "source_type", header: "Source", width: "w-[140px]" },
      { key: "account", header: "Account", width: "w-[220px]" },
      { key: "foreign_amount", header: "Foreign amount", format: "number", width: "w-[140px]" },
      {
        key: "booked_rate",
        header: "Booked rate",
        width: "w-[120px]",
        render: (row) => (
          <span className="font-mono text-xs">{fmtRate(row.values?.booked_rate as number | null)}</span>
        ),
      },
      { key: "booked_base_amount", header: "Booked base", format: "currency", width: "w-[150px]" },
      { key: "revalued_base_amount", header: "Revalued base", format: "currency", width: "w-[150px]" },
      { key: "difference", header: "Difference", format: "currency", width: "w-[140px]" },
    ],
    [],
  );

  const drillRows = useMemo<ReportRow[]>(
    () =>
      (drill?.items ?? []).map((i) => ({
        id: `${i.journal_entry_id}-${i.account_id}`,
        tone: (i.difference ?? 0) < 0 ? "danger" : "default",
        values: {
          entry_date: i.entry_date,
          entry_number: i.entry_number ?? "—",
          journal_entry_id: i.journal_entry_id,
          source_type: i.source_type ?? "—",
          account: [i.account_code, i.account_name].filter(Boolean).join(" · ") || "—",
          foreign_amount: i.foreign_amount,
          booked_rate: i.booked_rate,
          booked_base_amount: i.booked_base_amount,
          revalued_base_amount: i.revalued_base_amount,
          difference: i.difference,
        },
      })),
    [drill],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    const exportColumns: ExportColumn[] = [
      { key: "currency", header: "Currency", width: 12 },
      { key: "receivable", header: "Receivables", width: 16, align: "right" },
      { key: "payable", header: "Payables", width: 16, align: "right" },
      { key: "cash_bank", header: "Cash & bank", width: 16, align: "right" },
      { key: "other", header: "Other", width: 14, align: "right" },
      { key: "foreign_balance", header: "Net exposure", width: 16, align: "right" },
      { key: "rate", header: "Rate used", width: 14, align: "right" },
      { key: "provenance", header: "Rate source", width: 28 },
      { key: "booked", header: "Booked base", width: 18, format: "currency", align: "right" },
      { key: "revalued", header: "Revalued base", width: 18, format: "currency", align: "right" },
      { key: "difference", header: "Unrealized", width: 18, format: "currency", align: "right" },
    ];
    const exportRows: ExportRow[] = currencies.map((c) => ({
      currency: c.currency,
      receivable: c.receivable,
      payable: c.payable,
      cash_bank: c.cash_bank,
      other: c.other,
      foreign_balance: c.foreign_balance,
      rate: c.rate ?? "",
      provenance: provenance(c),
      booked: c.booked_base_amount,
      revalued: c.revalued_base_amount ?? "",
      difference: c.unrealized_difference ?? "",
    }));
    return {
      title: "FX Exposure",
      subtitle: `Open foreign-currency monetary balances as of ${asOf}`,
      formatProfile: "financial",
      columns: exportColumns,
      rows: exportRows,
      currency: base,
    };
  }, [currencies, asOf, base]);

  return (
    <ReportPageLayout
      title="FX Exposure"
      description="Open foreign-currency monetary balances with the rate the system would use, where that rate came from, and the unrealized difference a revaluation would post today. Reported at the legal-entity level."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && currencies.length === 0}
      emptyMessage="No open foreign-currency monetary balances as of this date."
      getExportConfig={getExportConfig}
      filters={
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">As of</Label>
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {missing.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>No rate on file for {missing.join(", ")}</AlertTitle>
            <AlertDescription>
              These balances are shown at their booked value only — nothing is converted at
              1:1. Add a rate in Settings → Currency before revaluing or closing the period.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard label="Currencies exposed" value={String(kpis.count)} />
          <KpiCard label="Booked base value" value={fmtMoney(kpis.booked, base)} />
          <KpiCard label="Revalued base value" value={fmtMoney(kpis.revalued, base)} />
          <KpiCard
            label="Unrealized difference"
            value={fmtMoney(kpis.diff, base)}
            tone={kpis.diff < 0 ? "negative" : "neutral"}
          />
        </div>

        <ReportSurface title="Exposure by currency" profile="operational" asOfDate={`As of ${asOf}`}>
          <ReportTable
            columns={columns}
            rows={tableRows}
            currency={base}
            caption="Open foreign-currency monetary balances with the resolved rate and its provenance"
            emptyMessage="No open foreign-currency monetary balances as of this date."
          />
        </ReportSurface>

        {selected && (
          <ReportSurface
            title={`${selected} open items`}
            profile="operational"
            asOfDate={`As of ${asOf}`}
            banner={
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                  Close
                </Button>
              </div>
            }
          >
            {drillLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading open items…</div>
            ) : (
              <ReportTable
                columns={drillColumns}
                rows={drillRows}
                currency={base}
                caption={`Entries behind the ${selected} exposure, with the rate booked on each`}
                emptyMessage="No open items for this currency."
              />
            )}
          </ReportSurface>
        )}
      </div>
    </ReportPageLayout>
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