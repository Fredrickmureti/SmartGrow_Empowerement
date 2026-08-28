/**
 * Consolidated Statements (Brick 5) — group income statement and balance sheet.
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * Every figure, including the totals and the "does it balance" verdict, comes
 * from `get_consolidated_statement_lines_eliminated` /
 * `get_consolidated_statement_totals_eliminated`, which are projections of the
 * same translated consolidated trial balance this app already reports. This
 * page performs no accounting arithmetic at all, so it cannot drift from the
 * trial balance or from the single-entity statements.
 *
 * The lines and the totals MUST come from the same projection. Footing the
 * aggregated totals under eliminated rows prints a total that does not equal
 * the lines above it and a balance verdict on a column nobody is reading.
 *
 * HONEST LIMITS (stated, never papered over)
 * ------------------------------------------
 * - Non-controlling interests are disclosed on the trial balance, not netted.
 * - Any scope or rate gap the engine refuses is surfaced verbatim.
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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ReportSurface,
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import {
  MemberContributionDialog,
  type MemberContributionTarget,
} from "@/components/reports/MemberContributionDialog";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { FileBarChart, ArrowLeft, AlertTriangle, Info, ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { useConsolidationGroups } from "@/hooks/finance/useConsolidationGroups";
import {
  useConsolidationScope,
  describeConsolidationBlocker,
} from "@/hooks/finance/useConsolidatedTrialBalance";
import {
  useConsolidatedStatementLines,
  useConsolidatedStatementTotals,
  sectionsOf,
  CONSOLIDATED_SECTION_LABELS,
  type ConsolidatedStatement,
  type ConsolidatedStatementLine,
} from "@/hooks/finance/useConsolidatedStatements";
import {
  useEliminatedStatementLines,
  useEliminatedStatementTotals,
  type EliminatedStatementLine,
} from "@/hooks/finance/useConsolidationEliminations";
import { ConsolidationRunHistory } from "@/components/reports/ConsolidationRunHistory";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { useReportViewLogger } from "@/hooks/reports/useReportViewLogger";

/**
 * A statement line carrying the three columns. The section/statement unions
 * come from the aggregated line type; the amounts come from the eliminated
 * projection, so neither can drift from its source.
 */
type ThreeColumnLine = ConsolidatedStatementLine &
  Pick<
    EliminatedStatementLine,
    | "aggregated_amount"
    | "elimination_amount"
    | "consolidated_amount"
    | "reconciling_amount"
  >;

function formatAmount(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/**
 * Three columns, in the order an accountant reads them: what the member
 * ledgers add up to, what the elimination engine removed, and what remains as
 * the group's figure. Every one of the three comes from the server — the page
 * never subtracts one column from another.
 *
 * LINEAGE OF EACH COLUMN
 * ----------------------
 * - Aggregated: the sum of the member companies' balances on this group
 *   account, so it drills to the consolidated trial balance narrowed to that
 *   account, where each company's contribution opens its own ledger.
 * - Eliminations: the engine's adjustment, so it drills to the legs behind it.
 * - Consolidated: aggregated less eliminations. It is a combination of the two
 *   columns beside it and owns no records of its own, so it is deliberately not
 *   a drill target — its explanation is the two links on the same row.
 */
function buildColumns(
  onOpenEliminations: (accountId: string) => void,
  onOpenTrialBalance: (accountId: string, label: string) => void,
): ReportColumn[] {
  const linked = (
    value: unknown,
    accountId: unknown,
    open: (id: string) => void,
    title: string,
  ) => {
    if (typeof value !== "string" || value === "—" || typeof accountId !== "string") {
      return <span className="tabular-nums">{(value as string) ?? ""}</span>;
    }
    return (
      <button
        type="button"
        title={title}
        className="tabular-nums underline underline-offset-2 hover:text-primary"
        onClick={() => open(accountId)}
      >
        {value}
      </button>
    );
  };

  return [
    { key: "code", header: "Account" },
    { key: "name", header: "Description" },
    {
      key: "aggregated",
      header: "Aggregated",
      align: "right",
      // Opens the member companies behind the figure IN PLACE: the reviewer
      // keeps this statement, its group and its period. A deep link into the
      // consolidated trial balance remains inside that dialog.
      render: (row) =>
        linked(
          row.values?.aggregated,
          row.values?.eliminationAccountId,
          (id) =>
            onOpenTrialBalance(
              id,
              `${(row.values?.code as string) ?? ""} ${(row.values?.name as string) ?? ""}`.trim(),
            ),
          "See the companies behind this figure",
        ),
    },

    {
      key: "elimination",
      header: "Eliminations",
      align: "right",
      // The figure is the server's; the link only carries the group, period
      // and account across to the eliminations report so the accountant can
      // read the legs behind it.
      render: (row) =>
        linked(
          row.values?.elimination,
          row.values?.eliminationAccountId,
          onOpenEliminations,
          "See the intercompany legs removed",
        ),
    },
    { key: "consolidated", header: "Consolidated", align: "right" },
  ];
}


export default function ConsolidatedStatements() {
  // Consolidated results are group-wide reads: who opened one, for which
  // group and period, is itself audit evidence (`report_views`). These pages
  // use ReportsLayout rather than ReportPageLayout, so they log explicitly.
  useReportViewLogger();
  const navigate = useNavigate();
  const { allowed: canViewConsolidated, isLoading: permLoading } =
    useFinancePermission("finance.view_consolidated");

  const today = new Date();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(endOfMonth(today), "yyyy-MM-dd"));

  // Statement line → the legs behind its Eliminations figure. Group, period
  // and group account travel as query params; the eliminations report reads
  // them and shows only that account's legs.
  const openEliminations = useCallback(
    (accountId: string) => {
      const params = new URLSearchParams({
        consolidationGroup: groupId ?? "",
        date_from: dateFrom,
        date_to: dateTo,
        group_account_id: accountId,
      });
      navigate(`/finance/reports/eliminations?${params.toString()}`);
    },
    [navigate, groupId, dateFrom, dateTo],
  );
  // Statement line → the member companies behind its Aggregated figure, opened
  // in place. Drill-down is preview → drawer → record without leaving the
  // report; the trial-balance route survives as a deep link inside the dialog.
  const [contributionTarget, setContributionTarget] =
    useState<MemberContributionTarget | null>(null);
  const openTrialBalance = useCallback(
    (accountId: string, label: string) => {
      if (!groupId) return;
      setContributionTarget({
        groupId,
        groupAccountId: accountId,
        label: label || "Group account",
        dateFrom,
        dateTo,
      });
    },
    [groupId, dateFrom, dateTo],
  );


  const COLUMNS = useMemo(
    () => buildColumns(openEliminations, openTrialBalance),
    [openEliminations, openTrialBalance],
  );

  const { data: groups, isLoading: groupsLoading } = useConsolidationGroups();
  const activeGroups = useMemo(() => (groups ?? []).filter((g) => g.is_active), [groups]);
  const selectedGroup = activeGroups.find((g) => g.id === groupId) ?? null;

  const scopeQuery = useConsolidationScope(
    canViewConsolidated ? groupId : null,
    canViewConsolidated ? dateTo : null,
  );
  const blockers = useMemo(
    () =>
      Array.from(
        new Set((scopeQuery.data ?? []).map((m) => m.blocker).filter(Boolean) as string[]),
      ),
    [scopeQuery.data],
  );
  const scopeIsClean = !!scopeQuery.data && blockers.length === 0;

  const readyGroupId = canViewConsolidated && scopeIsClean ? groupId : null;

  // Aggregated-only figures stay in play because they carry the balance-sheet
  // verdict and the currency translation reserve; the eliminated projection
  // carries the three columns and the post-elimination totals.
  const totalsQuery = useConsolidatedStatementTotals(readyGroupId, dateFrom, dateTo);
  const linesQuery = useEliminatedStatementLines(readyGroupId, dateFrom, dateTo);
  const eliminatedTotalsQuery = useEliminatedStatementTotals(readyGroupId, dateFrom, dateTo);

  const currency =
    totalsQuery.data?.presentation_currency ?? selectedGroup?.presentation_currency ?? "USD";
  // Shaped for sectionsOf: `amount` is the consolidated column, so section
  // grouping and ordering behave exactly as before. sectionsOf is generic in
  // the line shape, so the three columns survive the grouping. The cast only
  // narrows the server's `string` statement/section to their unions; the
  // column fields come from the eliminated row type, so they can't drift.
  const lines = useMemo(
    () =>
      (linesQuery.data ?? []).map((l) => ({
        ...l,
        amount: l.consolidated_amount,
      })) as unknown as ThreeColumnLine[],
    [linesQuery.data],
  );
  const eliminatedTotals = eliminatedTotalsQuery.data ?? null;
  const hasEliminations =
    !!eliminatedTotals &&
    (Number(eliminatedTotals.eliminations_debit) !== 0 ||
      Number(eliminatedTotals.eliminations_credit) !== 0);

  /**
   * The totals block and the balance verdict MUST come from the same
   * projection as the lines printed above them — the eliminated one.
   *
   * They previously came from `get_consolidated_statement_totals`, which foots
   * the *aggregated* lines. On any group with eliminations that puts a
   * pre-elimination total under post-elimination rows: the printed "Total
   * equity" did not equal the sum of the equity lines directly above it, and
   * "the consolidated balance sheet is in balance" was a verdict on a column
   * the reader was not looking at.
   *
   * The translation reserve comes from the same RPC for the same reason: the
   * disclosure has to move with the equity total it sits inside, so the server
   * foots it off the residual lines rather than the browser adding them up.
   *
   * This renames server fields onto the page's shape; it is not arithmetic.
   */
  const totals = useMemo(() => {
    if (!eliminatedTotals) return null;
    return {
      presentation_currency: eliminatedTotals.presentation_currency,
      total_income: Number(eliminatedTotals.total_income),
      total_expense: Number(eliminatedTotals.total_expense),
      net_result: Number(eliminatedTotals.net_result),
      total_assets: Number(eliminatedTotals.total_assets),
      total_liabilities: Number(eliminatedTotals.total_liabilities),
      total_equity: Number(eliminatedTotals.total_equity),
      translation_reserve: Number(eliminatedTotals.translation_reserve),
      balance_difference: Number(eliminatedTotals.balance_sheet_difference),
      is_balanced: eliminatedTotals.is_balanced,
    };
  }, [eliminatedTotals]);

  const rowsFor = (statement: ConsolidatedStatement): ReportRow[] => {
    const out: ReportRow[] = [];
    const money = (v: number) => formatAmount(Number(v), currency);
    /**
     * A residual the group's policy let through is disclosed by name on the
     * face of the statement, next to the figure carrying it. The amount is the
     * server's own `reconciling_amount`; nothing is derived here.
     */
    const describe = (l: ThreeColumnLine) =>
      l.account_name +
      (l.is_residual ? " (currency translation reserve)" : "") +
      (l.is_derived ? " (not yet posted to equity)" : "") +
      (Number(l.reconciling_amount ?? 0) !== 0
        ? ` — includes an unreconciled intragroup difference of ${money(
            Number(l.reconciling_amount),
          )}`
        : "");

    for (const group of sectionsOf(lines, statement)) {
      out.push({
        id: `${statement}:${group.section}`,
        kind: "section",
        label: CONSOLIDATED_SECTION_LABELS[group.section],
      });
      for (const line of group.lines) {
        out.push({
          id: `${statement}:${group.section}:${line.account_id ?? "derived"}`,
          values: {
            code: line.account_code ?? "—",
            name: describe(line),
            aggregated: money(line.aggregated_amount),
            elimination:
              Number(line.elimination_amount) === 0
                ? "—"
                : money(line.elimination_amount),
            eliminationAccountId: line.account_id ?? null,
            consolidated: money(line.consolidated_amount),
          },
        });
      }
    }
    return out;
  };

  /**
   * Export config per statement. Built from the same rows the screen shows,
   * with the server's own totals appended as total lines — nothing is
   * recomputed for the export. Amounts travel as formatted strings in the
   * group's presentation currency, which is not the active entity's base
   * currency.
   */
  const getExportConfig = useCallback(
    (statement: ConsolidatedStatement) => (): ExportConfig => {
      const money = (v: number) => formatAmount(Number(v), currency);
      const exportRows: ReportRow[] = [...rowsFor(statement)];

      if (totals) {
        if (statement === "income_statement") {
          exportRows.push(
            { id: "is-income", kind: "subtotal", values: { code: "", name: "Total income", aggregated: "", elimination: "", consolidated: money(totals.total_income) } },
            { id: "is-expense", kind: "subtotal", values: { code: "", name: "Total expenses", aggregated: "", elimination: "", consolidated: money(totals.total_expense) } },
            { id: "is-result", kind: "grandTotal", values: { code: "", name: "Result for the period", aggregated: "", elimination: "", consolidated: money(totals.net_result) } },
          );
        } else {
          exportRows.push(
            { id: "bs-assets", kind: "subtotal", values: { code: "", name: "Total assets", aggregated: "", elimination: "", consolidated: money(totals.total_assets) } },
            { id: "bs-liabilities", kind: "subtotal", values: { code: "", name: "Total liabilities", aggregated: "", elimination: "", consolidated: money(totals.total_liabilities) } },
            { id: "bs-equity", kind: "subtotal", values: { code: "", name: "Total equity", aggregated: "", elimination: "", consolidated: money(totals.total_equity) } },
          );
          if (Number(totals.translation_reserve) !== 0) {
            exportRows.push({
              id: "bs-cta",
              kind: "detail",
              values: { code: "", name: "of which currency translation reserve", aggregated: "", elimination: "", consolidated: money(totals.translation_reserve) },
            });
          }
          exportRows.push({
            id: "bs-balanced",
            kind: "note",
            label: totals.is_balanced
              ? "The consolidated balance sheet is in balance."
              : `The consolidated balance sheet is OUT OF BALANCE by ${money(totals.balance_difference)} — treat these figures as unreliable.`,
          });
        }
      }

      const isIncome = statement === "income_statement";
      return {
        title: isIncome ? "Consolidated Income Statement" : "Consolidated Balance Sheet",
        subtitle: `${selectedGroup?.name ?? "Consolidation group"} · projected from the consolidated trial balance · ${
          hasEliminations
            ? "aggregated, eliminations and consolidated columns"
            : "no eliminations generated for this period"
        } · live calculation, not a finalized consolidation run`,

        ...(isIncome
          ? {
              dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
            }
          : { asOf: format(new Date(dateTo), "MMM d, yyyy") }),
        columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
        rows: toExportRows(exportRows, COLUMNS as ReportColumn<never>[]),
        sheetName: isIncome ? "Income statement" : "Balance sheet",
        currency,
        // Registry keys: a group statement prints at statutory statement
        // typography (10pt, semantic total spacing, "Page i of N"). Landscape,
        // because a group statement carries three money columns plus the group
        // scope line — portrait A4 could not hold them without overflow.
        reportType: isIncome ? "consolidated_income_statement" : "consolidated_balance_sheet",
        orientation: "landscape",
        formatProfile: "financial",

        // Group artifact: issued by the group's parent company, never scoped
        // to a branch of whichever member the user is browsing.
        reportingEntityBusinessId: selectedGroup?.parent_business_id ?? null,
        branchId: null,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, totals, currency, dateFrom, dateTo, selectedGroup?.name, selectedGroup?.parent_business_id],
  );



  if (!permLoading && !canViewConsolidated) {
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
                    Consolidated statements need the <strong>consolidated view</strong>{" "}
                    finance permission, because they expose balances from every company in
                    the group.
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

  const scopeError = scopeQuery.error;
  const dataError =
    linesQuery.error ?? totalsQuery.error ?? eliminatedTotalsQuery.error;
  const isLoading =
    linesQuery.isLoading || totalsQuery.isLoading || eliminatedTotalsQuery.isLoading;

  return (
    <ReportsLayout>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="-ml-2">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>

        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <FileBarChart className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">Consolidated Statements</h1>
            <p className="text-muted-foreground mt-1">
              The group's income statement and balance sheet, built from the same
              consolidated trial balance — never recalculated alongside it.
            </p>
          </div>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            Figures are a projection of the consolidated trial balance: controlled
            companies at 100 % (IFRS 10 / ASC 810), foreign companies restated under
            IAS 21.{" "}
            Each line is shown three ways: aggregated from the member ledgers, the
            eliminations the engine removed, and the consolidated figure that remains.{" "}
            {hasEliminations ? (
              <strong>Intra-group positions have been eliminated for this period.</strong>
            ) : (
              <strong>
                No eliminations have been generated for this period, so intra-group
                trading still appears on both sides — run them from the Intercompany
                Eliminations report.
              </strong>
            )}
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Group and period</CardTitle>
            <CardDescription>
              Membership is effective-dated, so the group is resolved as of the end date.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label>Consolidation group</Label>
              <Select value={groupId ?? ""} onValueChange={(v) => setGroupId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder={groupsLoading ? "Loading…" : "Select a group"} />
                </SelectTrigger>
                <SelectContent>
                  {activeGroups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name} ({g.presentation_currency})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
          </CardContent>
        </Card>

        {!groupId ? (
          <Card>
            <CardHeader>
              <CardTitle>Pick a consolidation group</CardTitle>
              <CardDescription>
                Groups, ownership and consolidation methods are configured under{" "}
                <strong>Finance → Settings → Consolidation groups</strong>.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : scopeError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {scopeError instanceof Error
                ? scopeError.message
                : "Could not resolve the consolidation scope."}
            </AlertDescription>
          </Alert>
        ) : scopeQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !scopeIsClean ? (
          <div className="space-y-3">
            {blockers.map((b) => (
              <Alert key={b} variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  {describeConsolidationBlocker(b)}
                </AlertDescription>
              </Alert>
            ))}
          </div>
        ) : dataError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {dataError instanceof Error
                ? dataError.message
                : "The consolidated statements could not be produced for this period."}
            </AlertDescription>
          </Alert>
        ) : isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <CardTitle className="text-base">
                    Consolidated income statement — {selectedGroup?.name}
                  </CardTitle>
                  <CardDescription>
                    {dateFrom} to {dateTo}, presented in {currency}.
                  </CardDescription>
                </div>
                <ReportExportButtons
                  getExportConfig={getExportConfig("income_statement")}
                  compact
                />
              </CardHeader>
              <CardContent className="space-y-4">
                <ReportSurface
                  title={`Consolidated income statement — ${selectedGroup?.name ?? ""}`}
                  profile="financial"
                >
                  <ReportTable
                    columns={COLUMNS}
                    rows={rowsFor("income_statement")}
                    caption="Group income and expenses for the period"
                    emptyMessage="No posted income or expenses for this group and period"
                  />
                </ReportSurface>
                {totals && (
                  <div className="flex flex-wrap gap-6 text-sm">
                    <span>
                      Total income:{" "}
                      <strong>{formatAmount(Number(totals.total_income), currency)}</strong>
                    </span>
                    <span>
                      Total expenses:{" "}
                      <strong>{formatAmount(Number(totals.total_expense), currency)}</strong>
                    </span>
                    <span>
                      Result for the period:{" "}
                      <strong>{formatAmount(Number(totals.net_result), currency)}</strong>
                    </span>
                    {eliminatedTotals && (
                      <span>
                        Consolidated result:{" "}
                        <strong>
                          {formatAmount(Number(eliminatedTotals.net_result), currency)}
                        </strong>
                      </span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <CardTitle className="text-base">
                    Consolidated balance sheet — {selectedGroup?.name}
                  </CardTitle>
                  <CardDescription>
                    Position as of {dateTo}, presented in {currency}. The result for the
                    period is carried as its own equity line until the year is closed.
                  </CardDescription>
                </div>
                <ReportExportButtons
                  getExportConfig={getExportConfig("balance_sheet")}
                  compact
                />
              </CardHeader>
              <CardContent className="space-y-4">
                <ReportSurface
                  title={`Consolidated balance sheet — ${selectedGroup?.name ?? ""}`}
                  profile="financial"
                >
                  <ReportTable
                    columns={COLUMNS}
                    rows={rowsFor("balance_sheet")}
                    caption="Group assets, liabilities and equity"
                    emptyMessage="No balances for this group and period"
                  />
                </ReportSurface>
                {totals && (
                  <div className="flex flex-wrap items-center gap-6 text-sm">
                    <span>
                      Assets:{" "}
                      <strong>{formatAmount(Number(totals.total_assets), currency)}</strong>
                    </span>
                    <span>
                      Liabilities:{" "}
                      <strong>
                        {formatAmount(Number(totals.total_liabilities), currency)}
                      </strong>
                    </span>
                    <span>
                      Equity:{" "}
                      <strong>{formatAmount(Number(totals.total_equity), currency)}</strong>
                    </span>
                    {Number(totals.translation_reserve) !== 0 && (
                      <Badge variant="outline">
                        Translation reserve{" "}
                        {formatAmount(Number(totals.translation_reserve), currency)}
                      </Badge>
                    )}
                    {totals.is_balanced ? (
                      <span className="text-emerald-600">In balance</span>
                    ) : (
                      <span className="text-destructive font-semibold">
                        Out of balance by{" "}
                        {formatAmount(Number(totals.balance_difference), currency)}
                      </span>
                    )}
                  </div>
                )}
                {totals && !totals.is_balanced && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      The consolidated balance sheet does not balance. Treat these figures
                      as unreliable and check the consolidated trial balance and the
                      currency translation reserve before using them.
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            {/* The reporting record: runs read back from storage, beside the
                live view above. */}
            <ConsolidationRunHistory
              groupId={groupId}
              groupName={selectedGroup?.name ?? "this group"}
              dateFrom={dateFrom}
              dateTo={dateTo}
              canCreate={!!readyGroupId}
            />
          </>
        )}
      </div>

      {/* Lineage in place: the companies behind the clicked Aggregated figure. */}
      <MemberContributionDialog
        open={!!contributionTarget}
        onOpenChange={(next) => {
          if (!next) setContributionTarget(null);
        }}
        target={contributionTarget}
      />
    </ReportsLayout>
  );
}
