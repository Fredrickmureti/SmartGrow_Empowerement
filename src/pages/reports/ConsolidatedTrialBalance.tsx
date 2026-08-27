/**
 * Consolidated Trial Balance (Bricks 2 and 3).
 *
 * The first genuinely *consolidated* report in the system: it aggregates the
 * member companies of a consolidation group into one trial balance, restated
 * into the group's reporting currency.
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * Every figure comes from `get_consolidated_trial_balance_translated`, which
 * reads only the authoritative ledger functions and applies IAS 21 rates
 * server-side. This page performs no accounting arithmetic beyond regrouping
 * the server's rows by account, so it can never disagree with the formal
 * single-entity statements.
 *
 * HONEST LIMITS (deliberately not faked here)
 * -------------------------------------------
 * - No intercompany eliminations: the report says so explicitly.
 * - No equity-method accounting: such members are refused, not guessed.
 * - Translation is refused, never approximated, when the rate history does not
 *   cover the period or the group has no translation reserve account.
 * Non-controlling interests are *disclosed*, never netted into group figures.
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
import { Switch } from "@/components/ui/switch";
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
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { Layers, ArrowLeft, AlertTriangle, Info, ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { useConsolidationGroups, CONSOLIDATION_METHOD_LABELS } from "@/hooks/finance/useConsolidationGroups";
import {
  useConsolidationScope,
  useConsolidatedTrialBalance,
  useConsolidationCtaReconciliation,
  groupTrialBalanceByAccount,
  describeConsolidationBlocker,
  nonControllingShare,
  type ConsolidatedTrialBalanceRow,
} from "@/hooks/finance/useConsolidatedTrialBalance";

import { useFinancePermission } from "@/hooks/finance/useFinancePermission";

function formatAmount(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/**
 * Which IAS 21 rate restated a line, in the words an accountant would use.
 * Equity has no single rate — it moves at the rate of the day it moved — so the
 * figure shown there is the effective rate actually applied.
 */
const RATE_CLASS_LABELS: Record<string, string> = {
  closing: "closing rate",
  average: "average rate",
  transaction: "transaction-date rate",
  residual: "balancing figure",
};

function describeRate(row: ConsolidatedTrialBalanceRow): string {
  if (row.base_currency === row.presentation_currency) return "—";
  const label = RATE_CLASS_LABELS[row.rate_class] ?? row.rate_class;
  if (row.rate_used === null || row.rate_used === undefined) return label;
  return `${Number(row.rate_used).toFixed(4)} · ${label}`;
}



export default function ConsolidatedTrialBalance() {
  const navigate = useNavigate();
  const { allowed: canViewConsolidated, isLoading: permLoading } =
    useFinancePermission("finance.view_consolidated");

  const today = new Date();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(endOfMonth(today), "yyyy-MM-dd"));
  const [showMembers, setShowMembers] = useState(false);

  const { data: groups, isLoading: groupsLoading } = useConsolidationGroups();
  const activeGroups = useMemo(() => (groups ?? []).filter((g) => g.is_active), [groups]);
  const selectedGroup = activeGroups.find((g) => g.id === groupId) ?? null;

  const scopeQuery = useConsolidationScope(
    canViewConsolidated ? groupId : null,
    canViewConsolidated ? dateTo : null,
  );
  const blockers = useMemo(
    () => Array.from(new Set((scopeQuery.data ?? []).map((m) => m.blocker).filter(Boolean) as string[])),
    [scopeQuery.data],
  );
  const scopeIsClean = !!scopeQuery.data && blockers.length === 0;

  const tbQuery = useConsolidatedTrialBalance(
    canViewConsolidated && scopeIsClean ? groupId : null,
    dateFrom,
    dateTo,
  );

  /** True when at least one member keeps its books in another currency. */
  const hasTranslation = (scopeQuery.data ?? []).some((m) => m.requires_translation);

  const ctaQuery = useConsolidationCtaReconciliation(
    canViewConsolidated && scopeIsClean && hasTranslation ? groupId : null,
    dateFrom,
    dateTo,
  );

  const currency = selectedGroup?.presentation_currency ?? "USD";
  const accountLines = useMemo(
    () => groupTrialBalanceByAccount(tbQuery.data ?? []),
    [tbQuery.data],
  );
  const unmappedLineCount = useMemo(
    () => accountLines.filter((l) => !l.is_mapped && !l.is_residual).length,
    [accountLines],
  );


  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const line of accountLines) {
      debit += line.total_debit;
      credit += line.total_credit;
    }
    return { debit, credit, difference: debit - credit };
  }, [accountLines]);

  const nciDisclosure = useMemo(() => {
    const byMember = new Map<string, { name: string; ownership: number; amount: number }>();
    for (const row of tbQuery.data ?? []) {
      const owned = Number(row.ownership_percent ?? 100);
      if (owned >= 100) continue;
      if (!row.is_nominal) continue; // period result only
      const entry = byMember.get(row.business_id) ?? {
        name: row.business_name,
        ownership: owned,
        amount: 0,
      };
      entry.amount += nonControllingShare(row);
      byMember.set(row.business_id, entry);
    }
    return Array.from(byMember.values());
  }, [tbQuery.data]);

  const columns = useMemo<ReportColumn[]>(() => {
    const base: ReportColumn[] = [
      { key: "code", header: "Account" },
      { key: "name", header: "Description" },
      { key: "opening", header: "Opening", align: "right" },
      { key: "debit", header: "Debit", align: "right" },
      { key: "credit", header: "Credit", align: "right" },
      { key: "closing", header: "Closing", align: "right" },
    ];
    if (showMembers) {
      base.splice(2, 0, { key: "company", header: "Company" });
      if (hasTranslation) {
        base.splice(3, 0, { key: "rate", header: "Rate applied", align: "right" });
      }
    }
    return base;
  }, [showMembers, hasTranslation]);

  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    const money = (v: number) => formatAmount(v, currency);

    for (const line of accountLines) {
      out.push({
        id: line.account_id,
        values: {
          code: line.account_code ?? "—",
          name:
            line.account_name +
            (line.is_residual ? " (currency translation reserve)" : "") +
            (!line.is_mapped && !line.is_residual
              ? " — not mapped to a group account"
              : ""),
          company: showMembers ? "Group total" : "",
          rate: "",
          opening: money(line.opening_balance),
          debit: money(line.total_debit),
          credit: money(line.total_credit),
          closing: money(line.closing_balance),
        },
      });


      if (!showMembers) continue;
      for (const c of line.contributions as ConsolidatedTrialBalanceRow[]) {
        const source = c.base_currency ?? currency;
        const translated = source !== c.presentation_currency;
        // Foreign members are shown in their own currency, with the rate that
        // restated them, so a reviewer can retrace every group figure.
        const show = (own: number, group: number) =>
          translated
            ? `${formatAmount(own, source)} → ${money(group)}`
            : money(group);
        out.push({
          id: `${line.account_id}:${c.business_id}`,
          values: {
            code: "",
            name: "",
            company: c.business_name + (c.is_parent ? " (parent)" : ""),
            rate: describeRate(c),
            opening: show(Number(c.opening_balance), Number(c.translated_opening)),
            debit: show(Number(c.total_debit), Number(c.translated_debit)),
            credit: show(Number(c.total_credit), Number(c.translated_credit)),
            closing: show(Number(c.closing_balance), Number(c.translated_closing)),
          },
        });
      }
    }
    return out;
  }, [accountLines, showMembers, currency]);

  /**
   * Export config — the exported artifact is built from the SAME row model the
   * screen renders (`toExportRows`), so a CSV/XLSX/PDF cannot show a figure the
   * page does not. Amounts are exported as already-formatted strings in the
   * group's PRESENTATION currency: the ambient export context carries the
   * active entity's base currency, which is not the currency of a consolidated
   * statement, so numeric re-formatting downstream would mislabel every figure.
   */
  const getExportConfig = useCallback((): ExportConfig => {
    const exportRows: ReportRow[] = [
      ...rows,
      {
        id: "tb-total",
        kind: "grandTotal",
        values: {
          code: "",
          name: "TOTAL",
          company: showMembers ? "" : undefined,
          rate: "",
          opening: "",
          debit: formatAmount(totals.debit, currency),
          credit: formatAmount(totals.credit, currency),
          closing:
            Math.abs(totals.difference) < 0.005
              ? "In balance"
              : `Out of balance by ${formatAmount(totals.difference, currency)}`,
        },
      },
    ];
    if (unmappedLineCount > 0) {
      exportRows.push({
        id: "tb-unmapped-note",
        kind: "note",
        label: `* ${unmappedLineCount} account(s) report under a member company's own chart because no group account maps them.`,
      });
    }
    return {
      title: "Consolidated Trial Balance",
      subtitle: `${selectedGroup?.name ?? "Consolidation group"} · combined from the posted ledger · intercompany balances NOT eliminated`,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: toExportColumns(columns as ReportColumn<never>[]),
      rows: toExportRows(exportRows, columns as ReportColumn<never>[]),
      sheetName: "Consolidated TB",
      currency,
      formatProfile: "financial",
    };
  }, [
    rows,
    columns,
    currency,
    dateFrom,
    dateTo,
    selectedGroup?.name,
    showMembers,
    totals,
    unmappedLineCount,
  ]);


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
                    Consolidated reporting needs the <strong>consolidated view</strong>{" "}
                    finance permission, because it exposes balances from every company in
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
  const tbError = tbQuery.error;

  return (
    <ReportsLayout>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="-ml-2">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>

        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Layers className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">Consolidated Trial Balance</h1>
            <p className="text-muted-foreground mt-1">
              Member companies of a consolidation group, combined account by account —
              straight from the posted general ledger.
            </p>
          </div>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            Balances are combined at 100 % for controlled companies (IFRS 10 / ASC 810)
            and companies kept in another currency are restated under IAS 21 — assets
            and liabilities at the closing rate, income and expense at the average
            rate, equity at the rate of the day it moved.{" "}
            <strong>Intercompany balances are not yet eliminated</strong>, so intra-group
            trading still appears on both sides. This report refuses any scope it cannot
            combine honestly rather than approximating it.
          </AlertDescription>
        </Alert>


        <Card>
          <CardHeader>
            <CardTitle className="text-base">Group and period</CardTitle>
            <CardDescription>
              Membership is effective-dated, so the group is resolved as of the end date.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="members"
                checked={showMembers}
                onCheckedChange={setShowMembers}
              />
              <Label htmlFor="members" className="text-sm font-normal">
                Show each company's contribution under every account
              </Label>
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
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Consolidation scope</CardTitle>
                <CardDescription>
                  Companies in scope as of {dateTo}, with ownership and method.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {scopeError ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {scopeError instanceof Error
                        ? scopeError.message
                        : "Could not resolve the consolidation scope."}
                    </AlertDescription>
                  </Alert>
                ) : scopeQuery.isLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : (
                  <>
                    <ul className="space-y-2 text-sm">
                      {(scopeQuery.data ?? []).map((m) => (
                        <li
                          key={m.business_id}
                          className="flex flex-wrap items-center gap-2 border-b pb-2 last:border-0"
                        >
                          <span className="font-medium">{m.business_name}</span>
                          {m.is_parent && <Badge variant="secondary">Parent</Badge>}
                          <Badge variant="outline">{m.base_currency ?? "no currency"}</Badge>
                          {m.requires_translation && (
                            <Badge variant="outline">
                              translated to {m.presentation_currency}
                            </Badge>
                          )}

                          <span className="text-muted-foreground">
                            {Number(m.ownership_percent ?? 0)}% ·{" "}
                            {CONSOLIDATION_METHOD_LABELS[m.method] ?? m.method}
                          </span>
                          {m.blocker && (
                            <Badge variant="destructive">Blocks consolidation</Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                    {blockers.map((b) => (
                      <Alert key={b} variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription className="text-sm">
                          {describeConsolidationBlocker(b)}
                        </AlertDescription>
                      </Alert>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>

            {scopeIsClean && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Combined trial balance — {selectedGroup?.name}
                  </CardTitle>
                  <CardDescription>
                    {dateFrom} to {dateTo}, presented in {currency}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {tbError ? (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {tbError instanceof Error
                          ? tbError.message
                          : "Failed to build the consolidated trial balance."}
                      </AlertDescription>
                    </Alert>
                  ) : tbQuery.isLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-8 w-full" />
                      <Skeleton className="h-8 w-full" />
                    </div>
                  ) : (
                    <>
                      {unmappedLineCount > 0 && (
                        <Alert variant="destructive">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertDescription className="text-sm">
                            {unmappedLineCount} account{unmappedLineCount === 1 ? "" : "s"}{" "}
                            still report under a member company's own chart because no
                            group account maps them. Until they are mapped under{" "}
                            <strong>Finance → Settings → Consolidation groups</strong>, the
                            same economic account in two companies appears twice instead of
                            once.
                          </AlertDescription>
                        </Alert>
                      )}
                      <ReportSurface

                        title={`Consolidated trial balance — ${selectedGroup?.name ?? ""}`}
                        profile="financial"
                      >
                        <ReportTable
                          columns={columns}
                          rows={rows}
                          caption="Combined member balances by account"
                          emptyMessage="No posted activity for this group and period"
                        />
                      </ReportSurface>

                      <div className="flex flex-wrap gap-6 text-sm">
                        <span>
                          Total debits:{" "}
                          <strong>{formatAmount(totals.debit, currency)}</strong>
                        </span>
                        <span>
                          Total credits:{" "}
                          <strong>{formatAmount(totals.credit, currency)}</strong>
                        </span>
                        <span
                          className={
                            Math.abs(totals.difference) < 0.005
                              ? "text-emerald-600"
                              : "text-destructive font-semibold"
                          }
                        >
                          {Math.abs(totals.difference) < 0.005
                            ? "In balance"
                            : `Out of balance by ${formatAmount(totals.difference, currency)}`}
                        </span>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}

            {scopeIsClean && hasTranslation && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Currency translation reserve</CardTitle>
                  <CardDescription>
                    What the restatement above put into the reserve, checked against an
                    independent proof built from each company's opening net assets, its
                    result for the period and its dated equity movements.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {ctaQuery.error ? (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {ctaQuery.error instanceof Error
                          ? ctaQuery.error.message
                          : "Could not prove the translation reserve."}
                      </AlertDescription>
                    </Alert>
                  ) : ctaQuery.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : (
                    (ctaQuery.data ?? []).map((c) => (
                      <div key={c.business_id} className="space-y-1 border-b pb-3 last:border-0 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{c.business_name}</span>
                          <Badge variant="outline">
                            {c.base_currency} → {c.presentation_currency}
                          </Badge>
                          {c.is_reconciled ? (
                            <Badge variant="secondary">Proved</Badge>
                          ) : (
                            <Badge variant="destructive">Does not reconcile</Badge>
                          )}
                        </div>
                        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 text-muted-foreground">
                          <span>
                            Reserve brought forward:{" "}
                            <strong className="text-foreground">
                              {formatAmount(Number(c.opening_cta), currency)}
                            </strong>
                          </span>
                          <span>
                            Movement this period:{" "}
                            <strong className="text-foreground">
                              {formatAmount(Number(c.cta_movement), currency)}
                            </strong>
                          </span>
                          <span>
                            On opening net assets:{" "}
                            {formatAmount(Number(c.expected_from_opening_net_assets), currency)}
                          </span>
                          <span>
                            On the period result:{" "}
                            {formatAmount(Number(c.expected_from_result), currency)}
                          </span>
                          <span>
                            On equity movements:{" "}
                            {formatAmount(Number(c.expected_from_equity_movements), currency)}
                          </span>
                          <span>
                            Reserve carried forward:{" "}
                            <strong className="text-foreground">
                              {formatAmount(Number(c.closing_cta), currency)}
                            </strong>
                          </span>
                        </div>
                        {!c.is_reconciled && (
                          <Alert variant="destructive">
                            <AlertTriangle className="h-4 w-4" />
                            <AlertDescription>
                              The reserve moved by{" "}
                              {formatAmount(Number(c.cta_movement), currency)} but the
                              independent proof expects{" "}
                              {formatAmount(Number(c.expected_cta_movement), currency)} — a
                              difference of{" "}
                              {formatAmount(Number(c.movement_difference), currency)}. Treat
                              the translated figures for this company as unreliable until
                              this is explained.
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            )}



            {scopeIsClean && nciDisclosure.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Non-controlling interests</CardTitle>
                  <CardDescription>
                    Disclosed, not deducted: group figures above include 100 % of each
                    controlled company's balances.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1 text-sm">
                    {nciDisclosure.map((n) => (
                      <li key={n.name} className="flex justify-between gap-4">
                        <span>
                          {n.name} — minority share {(100 - n.ownership).toFixed(2)}%
                        </span>
                        <span className="font-medium">
                          {formatAmount(n.amount, currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </ReportsLayout>
  );
}
