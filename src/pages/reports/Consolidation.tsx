/**
 * Cross-Company Comparative View.
 *
 * This is the ONLY legitimate cross-company view in the system. Per industry
 * standards (Odoo, QuickBooks Advanced, Xero), aggregating financial data
 * across legal entities requires intercompany eliminations and currency
 * translation — features that belong to a future Phase 2 consolidation engine.
 *
 * Until that engine ships, we display each company's P&L *side by side* in
 * its own native currency. We do NOT sum across companies, we do NOT do FX
 * translation, and we do NOT eliminate intercompany transactions. The page
 * makes that boundary explicit so accountants and auditors are not misled.
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * Every figure below comes from `fetchGLTotals`, i.e. the `get_account_movements`
 * RPC — the same posted-GL engine behind the Trial Balance, P&L and the
 * dashboard. This page deliberately owns NO accounting arithmetic of its own:
 * a second, independent balance computation would be a second source of
 * accounting truth and could disagree with the formal statements.
 */
import { useCallback, useMemo, useState } from "react";
import { ReportsLayout } from "@/apps/reports";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { GitMerge, ArrowLeft, AlertTriangle, Info } from "lucide-react";
import { useNavigate, Link } from "react-router-dom";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchGLTotals } from "@/services/gl/fetchGLTotals";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { useReportViewLogger } from "@/hooks/reports/useReportViewLogger";
import {
  EntityPnlBreakdownDialog,
  type EntityPnlTarget,
  type PnlSection,
} from "@/components/reports/EntityPnlBreakdownDialog";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { ShieldAlert } from "lucide-react";

interface CompanyPnl {
  businessId: string;
  businessName: string;
  currency: string;
  income: number;
  expense: number;
  netIncome: number;
}

/**
 * Companies this user may actually read, resolved server-side via
 * `get_user_allowed_businesses`. The raw `businesses` list is org-scoped only;
 * relying on it here would let the column set imply the existence of companies
 * the caller has no grant for (RLS would then silently return zeros).
 */
function useAllowedBusinessIds(orgId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["consolidation-allowed-businesses", orgId, user?.id],
    enabled: !!orgId && !!user?.id,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase.rpc("get_user_allowed_businesses", {
        _user_id: user!.id,
        _org_id: orgId!,
      });
      if (error) throw error;
      return (data ?? []) as string[];
    },
  });
}

/**
 * Per-company P&L, one authoritative GL call per business.
 *
 * Unlike `useFinancialReport` this hook intentionally runs PER BUSINESS and
 * never blends them into a single total — that would require eliminations
 * and FX translation we don't yet support.
 */
function useComparativePnl(dateFrom: string, dateTo: string) {
  const { currentOrg } = useOrganization();
  const { businesses } = useBusinesses();
  const orgId = currentOrg?.id;
  const { data: allowedIds, isLoading: allowedLoading, error: allowedError } =
    useAllowedBusinessIds(orgId);

  const scopedBusinesses = useMemo(
    () => (allowedIds ? businesses.filter((b) => allowedIds.includes(b.id)) : []),
    [businesses, allowedIds],
  );

  const query = useQuery({
    queryKey: [
      "consolidation-comparative-pnl",
      orgId,
      dateFrom,
      dateTo,
      scopedBusinesses.map((b) => b.id),
    ],
    enabled: !!orgId && !!dateFrom && !!dateTo && scopedBusinesses.length > 0,
    queryFn: async (): Promise<CompanyPnl[]> => {
      const results: CompanyPnl[] = [];

      for (const biz of scopedBusinesses) {
        // Authoritative posted-GL totals — same engine as the formal reports.
        const totals = await fetchGLTotals(orgId!, dateFrom, dateTo, biz.id, null);

        results.push({
          businessId: biz.id,
          businessName: biz.name,
          currency: biz.base_currency || "—",
          income: totals.revenue,
          expense: totals.expenses,
          netIncome: totals.netProfit,
        });
      }

      return results;
    },
  });

  return {
    ...query,
    scopedBusinesses,
    isLoading: allowedLoading || query.isLoading,
    error: allowedError ?? query.error,
  };
}


function formatMoney(value: number, currency: string) {
  if (currency === "—") return value.toFixed(2);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export default function Consolidation() {
  // A cross-company read is audit evidence in its own right: who compared which
  // entities, over which period. Logged like every other consolidated surface.
  useReportViewLogger();
  const navigate = useNavigate();
  // Authorization mirrors the database, not an org-role guess: cross-company
  // figures need the same `finance.view_consolidated` permission the ledger RPCs
  // enforce. Tri-state — never render a denial while the answer is still loading.
  const { allowed: canViewConsolidation, isLoading: permLoading } = useFinancePermission(
    "finance.view_consolidated",
  );

  const today = new Date();
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(endOfMonth(today), "yyyy-MM-dd"));

  const { data: rows, isLoading, error, scopedBusinesses } = useComparativePnl(
    canViewConsolidation ? dateFrom : "",
    canViewConsolidation ? dateTo : "",
  );

  const currencies = useMemo(
    () => Array.from(new Set((rows ?? []).map((r) => r.currency))),
    [rows],
  );
  const mixedCurrency = currencies.length > 1;

  // Figure → the accounts behind it → the ledger lines → the source document,
  // all without leaving this comparison. The entity travels explicitly because
  // this view deliberately shows companies other than the active workspace one.
  const [pnlTarget, setPnlTarget] = useState<EntityPnlTarget | null>(null);
  const openBreakdown = useCallback(
    (row: ReportRow, section: PnlSection) => {
      const values = row.values as any;
      setPnlTarget({
        businessId: String(row.id),
        businessName: String(values?.businessName ?? ""),
        currency: String(values?.currency ?? "—"),
        section,
        dateFrom,
        dateTo,
      });
    },
    [dateFrom, dateTo],
  );

  const drillCell = useCallback(
    (row: ReportRow, section: PnlSection, display: React.ReactNode) => (
      <button
        type="button"
        title="See the accounts behind this figure"
        className="tabular-nums underline underline-offset-2 hover:text-primary"
        onClick={() => openBreakdown(row, section)}
      >
        {display}
      </button>
    ),
    [openBreakdown],
  );

  const comparisonColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "businessName", header: "Company" },
      {
        key: "currency",
        header: "Currency",
        render: (row) => <Badge variant="outline">{(row.values as any)?.currency as string}</Badge>,
      },
      {
        key: "income",
        header: "Income",
        align: "right",
        render: (row) =>
          drillCell(
            row,
            "income",
            formatMoney((row.values as any)?.income as number, (row.values as any)?.currency as string),
          ),
      },
      {
        key: "expense",
        header: "Expenses",
        align: "right",
        render: (row) =>
          drillCell(
            row,
            "expense",
            formatMoney((row.values as any)?.expense as number, (row.values as any)?.currency as string),
          ),
      },
      {
        key: "netIncome",
        header: "Net Income",
        align: "right",
        render: (row) => {
          const net = (row.values as any)?.netIncome as number;
          return drillCell(
            row,
            "net",
            <span className={`font-semibold ${net >= 0 ? "text-emerald-600" : "text-destructive"}`}>
              {formatMoney(net, (row.values as any)?.currency as string)}
            </span>,
          );
        },
      },
    ],
    [drillCell],
  );

  const comparisonRows = useMemo<ReportRow[]>(
    () =>
      (rows ?? []).map((r) => ({
        id: r.businessId,
        values: {
          businessName: r.businessName,
          currency: r.currency,
          income: r.income,
          expense: r.expense,
          netIncome: r.netIncome,
        },
      })),
    [rows],
  );

  /**
   * Export the comparison exactly as it reads on screen. Amounts are formatted
   * per company in that company's own currency, and the export carries the same
   * "not a consolidation" caveat as the page — an exported artifact must never
   * imply an addition across currencies that the report itself refuses to make.
   */
  const getExportConfig = useCallback((): ExportConfig => {
    const data = rows ?? [];
    return {
      title: "Cross-Company Comparative View",
      subtitle: mixedCurrency
        ? `Side-by-side profit & loss — each company in its own currency (${currencies.join(", ")}). Not a consolidation: figures are not summed, translated or eliminated.`
        : "Side-by-side profit & loss in each company's own books. Not a consolidation: figures are not summed, translated or eliminated.",
      dateRange: `${dateFrom} to ${dateTo}`,
      sheetName: "By company",
      columns: [
        { key: "company", header: "Company", width: 28 },
        { key: "currency", header: "Currency", width: 10 },
        { key: "income", header: "Income", width: 16, align: "right" },
        { key: "expense", header: "Expenses", width: 16, align: "right" },
        { key: "netIncome", header: "Net Income", width: 16, align: "right" },
      ],
      rows: data.map((r) => ({
        company: r.businessName,
        currency: r.currency,
        income: formatMoney(r.income, r.currency),
        expense: formatMoney(r.expense, r.currency),
        netIncome: formatMoney(r.netIncome, r.currency),
      })),
    };
  }, [rows, mixedCurrency, currencies, dateFrom, dateTo]);

  if (!permLoading && !canViewConsolidation) {
    return (
      <ReportsLayout>
        <div className="max-w-2xl mx-auto px-4 py-12">
          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0">
                  <ShieldAlert className="h-5 w-5 text-destructive" />
                </div>
                <div>
                  <CardTitle>Restricted view</CardTitle>
                  <CardDescription>
                    Cross-company comparative reports need the{" "}
                    <strong>consolidated view</strong> finance permission, because they
                    expose figures from every legal entity you can access.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Go back
              </Button>
            </CardContent>
          </Card>
        </div>
      </ReportsLayout>
    );
  }

  return (
    <ReportsLayout>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="-ml-2">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>

        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <GitMerge className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">Cross-Company Comparative View</h1>
            <p className="text-muted-foreground mt-1">
              Per-company P&amp;L, side by side. Each column stays in its own books and
              currency — no totals, no eliminations.
            </p>
          </div>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            <strong>This is a side-by-side comparison, not a consolidation.</strong> Each
            column stays on its own books in its own currency — use it to compare
            companies, not to add the figures together. For consolidated results with FX
            translation and intercompany identification, use the consolidated reports
            below.
          </AlertDescription>
        </Alert>

        {mixedCurrency && (
          <Alert variant="default" className="border-warning/50">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertDescription className="text-sm">
              Your companies report in {currencies.length} different currencies
              ({currencies.join(", ")}). Comparing the absolute amounts is misleading
              without FX translation — focus on each company's own trend.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reporting period</CardTitle>
            <CardDescription>Applied to every company column.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
              <div className="space-y-1">
                <Label htmlFor="from">From</Label>
                <Input
                  id="from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="to">To</Label>
                <Input
                  id="to"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {scopedBusinesses.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No companies yet</CardTitle>
              <CardDescription>
                Create a company under <strong>Settings → Organization</strong> to start
                using the comparative view.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">Profit &amp; Loss — by company</CardTitle>
                  <CardDescription>
                    Native-currency totals for the selected period. Click any figure to
                    see the accounts and ledger lines behind it.
                  </CardDescription>
                </div>
                {/* Same artifact stack as every other report: preview, print, PDF, Excel, CSV. */}
                <ReportExportButtons getExportConfig={getExportConfig} />
              </div>
            </CardHeader>
            <CardContent>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {error instanceof Error ? error.message : "Failed to load report."}
                  </AlertDescription>
                </Alert>
              ) : isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (
                <ReportSurface title="Profit & Loss — by company" profile="financial">
                  <ReportTable
                    columns={comparisonColumns}
                    rows={comparisonRows}
                    caption="Per-company profit and loss, native currency"
                    emptyMessage="No companies to compare"
                  />
                </ReportSurface>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consolidated reporting</CardTitle>
            <CardDescription>
              Full consolidation with FX translation and intercompany identification,
              presented in the group currency.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/finance/reports/consolidated-trial-balance">
                  Consolidated Trial Balance
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/finance/reports/consolidated-statements">
                  Consolidated Statements
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/finance/reports/intercompany">
                  Intercompany Activity
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Lineage in place: accounts behind a company's figure, then its ledger. */}
      <EntityPnlBreakdownDialog
        open={!!pnlTarget}
        onOpenChange={(next) => {
          if (!next) setPnlTarget(null);
        }}
        target={pnlTarget}
      />
    </ReportsLayout>
  );
}
