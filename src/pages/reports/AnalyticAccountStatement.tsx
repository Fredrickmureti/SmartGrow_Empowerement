/**
 * Analytic Account Statement (Phase 5 — consumer #1)
 *
 * Line-level movement of the GL analytic ledger
 * (`journal_entry_line_analytics`), grouped per analytic account with a
 * server-computed running balance, drillable to the originating journal
 * entry. Only `posted` / `reversed` entries are included, so the statement
 * ties out to the General Ledger by construction.
 *
 * Aggregation and the running balance are computed by
 * `public.analytic_account_statement` — the browser only renders rows.
 */

import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { ReportFilterProvider, useReportFilters } from "@/contexts/ReportFilterContext";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { useCurrency } from "@/hooks/useCurrency";
import { useAnalyticAccounts } from "@/hooks/useAnalyticAccounts";
import {
  useAnalyticAccountStatement,
  useProjectAnalyticReconciliation,
} from "@/hooks/finance/useAnalyticReports";
import type { ExportColumn, ExportConfig, ExportRow } from "@/services/reports/ReportExportService";

const ALL = "__all__";

function AnalyticAccountStatementInner() {
  const { filters, setDateFrom, setDateTo } = useReportFilters();
  const { baseCurrency } = useCurrency();
  const { plans = [], accounts = [] } = useAnalyticAccounts() as any;

  const [planId, setPlanId] = useState<string>(ALL);
  const [accountId, setAccountId] = useState<string>(ALL);

  const range = { dateFrom: filters.dateFrom, dateTo: filters.dateTo };
  const { data: rows = [], isLoading, error } = useAnalyticAccountStatement(
    range,
    accountId === ALL ? null : accountId,
    planId === ALL ? null : planId,
  );
  const { data: variances = [] } = useProjectAnalyticReconciliation(range);

  const selectableAccounts = useMemo(
    () =>
      (accounts as any[]).filter((a) => planId === ALL || a.plan_id === planId),
    [accounts, planId],
  );

  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "entry_date", header: "Date" },
      { key: "entry_number", header: "Entry" },
      { key: "account", header: "GL account" },
      { key: "description", header: "Description" },
      { key: "status", header: "Status" },
      { key: "debit", header: "Debit", format: "currency", align: "right" },
      { key: "credit", header: "Credit", format: "currency", align: "right" },
      { key: "running_balance", header: "Balance", format: "currency", align: "right" },
    ],
    [],
  );

  /**
   * Rows are grouped per analytic account for readability. Every amount comes
   * from the RPC; the subtotal is the server-computed running balance of the
   * account's last line, not a browser re-aggregation.
   */
  const reportRows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    let currentAccount: string | null = null;
    rows.forEach((r, idx) => {
      if (r.analytic_account_id !== currentAccount) {
        currentAccount = r.analytic_account_id;
        out.push({
          id: `hdr-${r.analytic_account_id}`,
          kind: "section",
          label: `${r.analytic_code ? `${r.analytic_code} · ` : ""}${r.analytic_name} (${r.plan_name})`,
          values: {},
        });
      }
      out.push({
        id: `${r.journal_entry_line_id ?? r.journal_entry_id}-${idx}`,
        kind: "detail",
        values: {
          entry_date: r.entry_date,
          entry_number: r.entry_number ?? "",
          account: [r.account_code, r.account_name].filter(Boolean).join(" · "),
          description: r.description ?? "",
          status: r.status,
          debit: r.debit,
          credit: r.credit,
          running_balance: r.running_balance,
        },
        href: `/finance/journal-entries/${r.journal_entry_id}`,
      } as ReportRow);

      const next = rows[idx + 1];
      if (!next || next.analytic_account_id !== r.analytic_account_id) {
        out.push({
          id: `sub-${r.analytic_account_id}`,
          kind: "subtotal",
          label: "Closing balance",
          values: {
            entry_date: null,
            entry_number: null,
            account: null,
            description: null,
            status: null,
            debit: null,
            credit: null,
            running_balance: r.running_balance,
          },
        });
      }
    });
    return out;
  }, [rows]);

  const getExportConfig = useCallback((): ExportConfig => {
    const columnsX: ExportColumn[] = [
      { key: "analytic", header: "Analytic account", width: 32 },
      { key: "entry_date", header: "Date", width: 14 },
      { key: "entry_number", header: "Entry", width: 18 },
      { key: "account", header: "GL account", width: 32 },
      { key: "description", header: "Description", width: 40 },
      { key: "debit", header: "Debit", width: 16, format: "currency", align: "right" },
      { key: "credit", header: "Credit", width: 16, format: "currency", align: "right" },
      { key: "running_balance", header: "Balance", width: 16, format: "currency", align: "right" },
    ];
    const exportRows: ExportRow[] = rows.map((r) => ({
      analytic: `${r.analytic_code ? `${r.analytic_code} · ` : ""}${r.analytic_name}`,
      entry_date: r.entry_date,
      entry_number: r.entry_number ?? "",
      account: [r.account_code, r.account_name].filter(Boolean).join(" · "),
      description: r.description ?? "",
      debit: r.debit,
      credit: r.credit,
      running_balance: r.running_balance,
    }));
    return {
      title: "Analytic Account Statement",
      subtitle: `${filters.dateFrom} → ${filters.dateTo}`,
      columns: columnsX,
      rows: exportRows,
      currency: baseCurrency,
    };
  }, [rows, filters.dateFrom, filters.dateTo, baseCurrency]);

  const drifting = useMemo(
    () => variances.filter((v) => Math.abs(v.difference) > 0.01),
    [variances],
  );

  return (
    <ReportPageLayout
      title="Analytic Account Statement"
      description="Every posted journal line carrying an analytic account, in date order, with a running balance per account. Drafts are excluded and reversals are shown, so the statement ties to the General Ledger."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No analytic movement in this period. Tag documents with a cost centre, department or project and post them."
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="aas-from" className="text-xs">From</Label>
            <Input id="aas-from" type="date" className="w-[160px]" value={filters.dateFrom}
              onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="aas-to" className="text-xs">To</Label>
            <Input id="aas-to" type="date" className="w-[160px]" value={filters.dateTo}
              onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Analytic plan</Label>
            <Select value={planId} onValueChange={(v) => { setPlanId(v); setAccountId(ALL); }}>
              <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All plans</SelectItem>
                {(plans as any[]).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Analytic account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All accounts</SelectItem>
                {selectableAccounts.map((a: any) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code ? `${a.code} · ${a.name}` : a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <ReportSurface
          title="Analytic Account Statement"
          subtitle={`${filters.dateFrom} → ${filters.dateTo} · ${rows.length} analytic line(s)`}
          profile="financial"
        >
          <ReportTable
            columns={columns}
            rows={reportRows}
            currency={baseCurrency}
            caption="Posted analytic movement with running balance"
            emptyMessage="No analytic movement in the selected period"
          />
        </ReportSurface>

        {drifting.length > 0 && (
          <div className="rounded-md border bg-card p-4 space-y-2">
            <h3 className="text-sm font-semibold">Project ledger variance</h3>
            <p className="text-xs text-muted-foreground">
              Projects where the GL analytic ledger and the operational project
              ledger disagree. Non-GL costs (timesheets, commitments) legitimately
              appear here; a difference on a purely financial project does not.
            </p>
            <ul className="divide-y rounded border bg-background">
              {drifting.map((v) => (
                <li key={v.project_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{v.project_name}</div>
                    <div className="text-xs text-muted-foreground">
                      GL {v.gl_analytic_net.toFixed(2)} · project ledger {v.project_ledger_net.toFixed(2)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm">{v.difference.toFixed(2)}</span>
                    <Link className="text-xs underline" to={`/projects/${v.project_id}`}>Open project</Link>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ReportPageLayout>
  );
}

export default function AnalyticAccountStatement() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Analytic account statement">
        <AnalyticAccountStatementInner />
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
