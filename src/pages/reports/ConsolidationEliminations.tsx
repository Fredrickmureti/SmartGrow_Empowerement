/**
 * Intercompany Eliminations (Brick 7).
 *
 * The screen where an accountant asks the engine to remove intra-group
 * positions from the group's figures, then reads exactly what was removed and
 * why.
 *
 * This page computes nothing. Generation, the tolerance test, the refusal when
 * two sides of a declared pair disagree, and the residual posted under a
 * difference policy all happen inside
 * `consolidation_generate_eliminations`. The elimination rows themselves are
 * engine output — a database trigger refuses hand-written ones — so there is no
 * edit action here by design.
 *
 * Every refusal from the database is shown in the database's own words.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import {
  ArrowLeft,
  AlertTriangle,
  Info,
  Loader2,
  Scissors,
  ShieldAlert,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { toast } from "sonner";
import { toAppError } from "@/lib/supabaseError";
import {
  useConsolidationGroups,
  useCanManageConsolidation,
} from "@/hooks/finance/useConsolidationGroups";
import {
  useConsolidationScope,
  describeConsolidationBlocker,
} from "@/hooks/finance/useConsolidatedTrialBalance";
import {
  ELIMINATION_CLASS_LABELS,
  ELIMINATION_POLICY_LABELS,
  useConsolidationEliminations,
  useConsolidationEliminationRules,
  useConsolidationEliminationMutations,
  useConsolidationIntercompanyFlows,
  useEliminatedStatementTotals,
  useEliminationDiagnosis,
} from "@/hooks/finance/useConsolidationEliminations";
import { EliminationRefusalPanel } from "@/components/finance/EliminationRefusalPanel";
import { EliminationEvidencePanel } from "@/components/finance/EliminationEvidencePanel";


import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { useReportViewLogger } from "@/hooks/reports/useReportViewLogger";

function formatAmount(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export default function ConsolidationEliminations() {
  // Consolidated results are group-wide reads: who opened one, for which
  // group and period, is itself audit evidence (`report_views`). These pages
  // use ReportsLayout rather than ReportPageLayout, so they log explicitly.
  useReportViewLogger();
  const navigate = useNavigate();
  const { allowed: canViewConsolidated, isLoading: permLoading } =
    useFinancePermission("finance.view_consolidated");

  // A consolidated statement line links here with its group, period and the
  // group account whose Eliminations column was clicked, so the drill-down
  // opens on the same figure the accountant was reading.
  const [searchParams] = useSearchParams();
  const today = new Date();
  const [groupId, setGroupId] = useState<string | null>(
    searchParams.get("consolidationGroup"),
  );
  const [dateFrom, setDateFrom] = useState(
    searchParams.get("date_from") ?? format(startOfMonth(today), "yyyy-MM-dd"),
  );
  const [dateTo, setDateTo] = useState(
    searchParams.get("date_to") ?? format(endOfMonth(today), "yyyy-MM-dd"),
  );
  const [focusAccountId, setFocusAccountId] = useState<string | null>(
    searchParams.get("group_account_id"),
  );
  const [refusal, setRefusal] = useState<string | null>(null);

  const { data: groups, isLoading: groupsLoading } = useConsolidationGroups();
  const activeGroups = useMemo(() => (groups ?? []).filter((g) => g.is_active), [groups]);
  const selectedGroup = activeGroups.find((g) => g.id === groupId) ?? null;
  const currency = selectedGroup?.presentation_currency ?? "USD";

  const scopeQuery = useConsolidationScope(
    canViewConsolidated ? groupId : null,
    canViewConsolidated ? dateTo : null,
  );
  const members = scopeQuery.data ?? [];
  const blockers = useMemo(
    () => Array.from(new Set(members.map((m) => m.blocker).filter(Boolean) as string[])),
    [members],
  );
  const scopeIsClean = !!scopeQuery.data && blockers.length === 0;
  const readyGroupId = canViewConsolidated && scopeIsClean ? groupId : null;

  const eliminationsQuery = useConsolidationEliminations(readyGroupId, dateFrom, dateTo);
  const rulesQuery = useConsolidationEliminationRules(groupId);
  const flowsQuery = useConsolidationIntercompanyFlows(readyGroupId, dateFrom, dateTo);
  const totalsQuery = useEliminatedStatementTotals(readyGroupId, dateFrom, dateTo);
  // Read-only server preflight: why this period would be refused, and which
  // remedies the engine itself would accept.
  const diagnosisQuery = useEliminationDiagnosis(readyGroupId, dateFrom, dateTo);
  const canManageConsolidation = useCanManageConsolidation();
  const { generate } = useConsolidationEliminationMutations();


  const eliminations = eliminationsQuery.data ?? [];
  const hasRun = eliminations.length > 0;
  const differences = eliminations.filter((r) => r.is_difference);

  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "kind", header: "Class" },
      { key: "declaring", header: "Company" },
      { key: "counterparty", header: "Counterparty" },
      { key: "group_account", header: "Group account" },
      { key: "debit", header: "Debit", align: "right" },
      { key: "credit", header: "Credit", align: "right" },
      { key: "note", header: "Note" },
    ],
    [],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const money = (v: number) => formatAmount(Number(v), currency);
    return eliminations.map((r) => ({
      id: r.id,
      values: {
        kind: ELIMINATION_CLASS_LABELS[r.elimination_class] ?? r.elimination_class,
        declaring: r.declaring_business_name,
        counterparty: r.counterparty_business_name,
        group_account: `${r.group_account_code} · ${r.group_account_name}`,
        debit: money(r.debit),
        credit: money(r.credit),
        note: r.is_difference ? "Unreconciled residual, disclosed" : "Eliminated",
      },
    }));
  }, [eliminations, currency]);

  const flowColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "declaring", header: "Company" },
      { key: "counterparty", header: "Counterparty" },
      { key: "group_account", header: "Group account" },
      { key: "account", header: "Its account" },
      { key: "debit", header: "Debit", align: "right" },
      { key: "credit", header: "Credit", align: "right" },
      { key: "rate", header: "Rate" },
    ],
    [],
  );

  const flowRows = useMemo<ReportRow[]>(() => {
    const money = (v: number) => formatAmount(Number(v), currency);
    return (flowsQuery.data ?? []).map((r, i) => ({
      id: `${r.declaring_business_id}:${r.counterparty_business_id}:${r.account_id}:${i}`,
      values: {
        declaring: r.declaring_business_name,
        counterparty: r.counterparty_business_name,
        group_account: `${r.group_account_code} · ${r.group_account_name}`,
        account: `${r.account_code} · ${r.account_name}`,
        debit: money(r.debit_presentation),
        credit: money(r.credit_presentation),
        rate: `${r.rate_class} @ ${Number(r.rate_used)}`,
      },
    }));
  }, [flowsQuery.data, currency]);

  const period = `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`;
  const groupLabel = selectedGroup?.name ?? "Consolidation group";

  const buildConfig = useCallback(
    (
      title: string,
      subtitle: string,
      sheetName: string,
      cols: ReportColumn[],
      rws: ReportRow[],
    ): ExportConfig => ({
      title,
      subtitle,
      dateRange: period,
      columns: toExportColumns(cols as ReportColumn<never>[]),
      rows: toExportRows(rws, cols as ReportColumn<never>[]),
      sheetName,
      currency,
      formatProfile: "financial",
    }),
    [period, currency],
  );

  const getEliminationsExport = useCallback(
    (): ExportConfig =>
      buildConfig(
        "Intercompany Eliminations",
        `${groupLabel} · generated by the consolidation engine from declared intra-group pairs, in ${currency}`,
        "Eliminations",
        columns,
        rows,
      ),
    [buildConfig, columns, rows, currency, groupLabel],
  );

  const getFlowsExport = useCallback(
    (): ExportConfig =>
      buildConfig(
        "Intercompany Positions Consumed",
        `${groupLabel} · the translated positions the elimination run read, account by account`,
        "IC positions",
        flowColumns,
        flowRows,
      ),
    [buildConfig, flowColumns, flowRows, groupLabel],
  );

  const runGeneration = async () => {
    if (!groupId) return;
    setRefusal(null);
    try {
      const summary = await generate.mutateAsync({
        group_id: groupId,
        date_from: dateFrom,
        date_to: dateTo,
      });
      const lines = summary.reduce((n, s) => n + Number(s.line_count), 0);
      toast.success(
        lines === 0
          ? "The engine found nothing to eliminate for this period"
          : `Eliminations generated — ${lines} line${lines === 1 ? "" : "s"}`,
      );
    } catch (e) {
      // Verbatim: the refusal names the exact pair, rate or mapping at fault.
      // toAppError keeps a PostgrestError's message/details/hint — a bare
      // `instanceof Error` test would have thrown all of that away.
      const message = toAppError(e, "The elimination run was refused").message;
      setRefusal(message);
      toast.error(message);
    }
  };

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
                    Eliminations need the <strong>consolidated view</strong> finance
                    permission, because they expose balances from every company in the
                    group.
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

  const totals = totalsQuery.data;

  return (
    <ReportsLayout>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="-ml-2">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>

        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Scissors className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">Intercompany Eliminations</h1>
            <p className="text-muted-foreground mt-1">
              Remove declared intra-group balances and trading from the group's figures,
              and show precisely what was removed.
            </p>
          </div>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            Only relationships declared on the Intercompany screen are eliminated —
            nothing is inferred from a name or an account code. Amounts are read from the
            translated consolidated trial balance, so an elimination can never drift from
            the statement line it offsets. Where the two sides of a pair disagree beyond
            the group's tolerance, the run is refused unless the policy names an account
            for the residual.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Group and period</CardTitle>
            <CardDescription>
              Membership and declarations are effective-dated, so both are resolved as of
              the end date.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
            <div className="space-y-1">
              <Label>Consolidation group</Label>
              <Select value={groupId ?? ""} onValueChange={(v) => setGroupId(v)}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={groupsLoading ? "Loading…" : "Select a group"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {activeGroups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name} · {g.presentation_currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="elim-from">From</Label>
              <Input
                id="elim-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="elim-to">To</Label>
              <Input
                id="elim-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
            <Button
              onClick={runGeneration}
              disabled={!groupId || !scopeIsClean || generate.isPending}
            >
              {generate.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {hasRun ? "Regenerate" : "Generate eliminations"}
            </Button>
          </CardContent>
        </Card>

        {blockers.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="space-y-1">
              {blockers.map((b) => (
                <div key={b}>{describeConsolidationBlocker(b)}</div>
              ))}
            </AlertDescription>
          </Alert>
        )}

        {groupId && (
          <EliminationRefusalPanel
            groupId={groupId}
            currency={currency}
            canManage={canManageConsolidation}
            refusal={refusal}
            diagnosis={diagnosisQuery.data ?? []}
            isLoading={diagnosisQuery.isLoading}
            error={diagnosisQuery.error}
            rules={rulesQuery.data ?? []}
          />
        )}


        {groupId && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Policy in force</CardTitle>
              <CardDescription>
                Set per group in Finance settings, under the consolidation group.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {(rulesQuery.data ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No policy saved — every class is produced and any disagreement between
                  the two sides refuses the run.
                </p>
              )}
              {(rulesQuery.data ?? []).map((rule) => (
                <div
                  key={rule.id}
                  className="flex flex-wrap items-center gap-2 text-sm border rounded-md px-3 py-2"
                >
                  <span className="font-medium">
                    {ELIMINATION_CLASS_LABELS[rule.elimination_class] ??
                      rule.elimination_class}
                  </span>
                  <Badge variant={rule.is_active ? "secondary" : "outline"}>
                    {rule.is_active ? "Produced" : "Switched off"}
                  </Badge>
                  <span className="text-muted-foreground">
                    Tolerance {formatAmount(Number(rule.tolerance_amount), currency)} ·{" "}
                    {ELIMINATION_POLICY_LABELS[rule.difference_policy] ??
                      rule.difference_policy}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {totals && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Effect on the group's statements</CardTitle>
              <CardDescription>
                Totals after elimination, as the server reports them.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Eliminated debits</p>
                <p className="font-medium">
                  {formatAmount(Number(totals.eliminations_debit), currency)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Eliminated credits</p>
                <p className="font-medium">
                  {formatAmount(Number(totals.eliminations_credit), currency)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Net result</p>
                <p className="font-medium">
                  {formatAmount(Number(totals.net_result), currency)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Balance sheet</p>
                <p className="font-medium">
                  {totals.is_balanced
                    ? "Balanced"
                    : `Out by ${formatAmount(Number(totals.balance_sheet_difference), currency)}`}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {differences.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {differences.length} residual{differences.length === 1 ? "" : "s"} could not
              be eliminated and {differences.length === 1 ? "was" : "were"} posted to the
              difference account under the group's policy. These are unreconciled
              intra-group positions and remain in the group's figures until the two sides
              agree.
            </AlertDescription>
          </Alert>
        )}

        {groupId && (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">Generated eliminations</CardTitle>
                <CardDescription>
                  Engine output for {period}. These rows cannot be edited by hand.
                  Open a leg to see the source accounts and posted entries behind it.

                </CardDescription>
              </div>
              {hasRun && <ReportExportButtons getExportConfig={getEliminationsExport} />}
            </CardHeader>
            <CardContent>
              <EliminationEvidencePanel
                groupId={groupId}
                dateFrom={dateFrom}
                dateTo={dateTo}
                currency={currency}
                eliminations={eliminations}
                rules={rulesQuery.data ?? []}
                isLoading={eliminationsQuery.isLoading}
                focusAccountId={focusAccountId}
                onClearFocus={() => setFocusAccountId(null)}
              />
            </CardContent>

          </Card>
        )}

        {groupId && (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">Positions the run consumed</CardTitle>
                <CardDescription>
                  The declared intra-group activity behind each elimination, translated at
                  the group's rates.
                </CardDescription>
              </div>
              {flowRows.length > 0 && (
                <ReportExportButtons getExportConfig={getFlowsExport} />
              )}
            </CardHeader>
            <CardContent>
              <ReportTable
                columns={flowColumns}
                rows={flowRows}
                isLoading={flowsQuery.isLoading}
              />
            </CardContent>
          </Card>
        )}
      </div>
    </ReportsLayout>
  );
}
