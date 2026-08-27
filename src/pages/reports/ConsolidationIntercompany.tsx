/**
 * Intercompany Identification (Brick 6).
 *
 * Two jobs, deliberately kept apart on the page:
 *
 * 1. DECLARE — say which contact inside a member company IS another member
 *    company. An explicit, effective-dated, audited statement by a person.
 *    Nothing here is inferred from names or account codes.
 * 2. RECONCILE — read the paired positions the server computes: what one member
 *    says it is owed against what the other says it owes, both in the group's
 *    presentation currency at the group's own closing rate.
 *
 * This page performs no accounting arithmetic. Every balance, translation and
 * difference comes from `consolidation_intercompany_balances`. It also produces
 * NO elimination entries: a mismatch is a finding for an accountant, and the
 * consolidated statements are unchanged by anything on this screen.
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
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { ArrowLeft, ArrowLeftRight, Info, ShieldAlert, AlertTriangle, Plus, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { toast } from "sonner";
import { useConsolidationGroups } from "@/hooks/finance/useConsolidationGroups";
import { useConsolidationScope, describeConsolidationBlocker } from "@/hooks/finance/useConsolidatedTrialBalance";
import {
  useConsolidationIntercompanyPartners,
  useConsolidationMemberContacts,
  useConsolidationIntercompanyBalances,
  useConsolidationIntercompanyActivity,
  useConsolidationIntercompanyCoverage,
  useConsolidationIntercompanyMutations,
  isReconciled,
} from "@/hooks/finance/useConsolidationIntercompany";

import { useFinancePermission } from "@/hooks/finance/useFinancePermission";

function formatAmount(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export default function ConsolidationIntercompany() {
  const navigate = useNavigate();
  const { allowed: canViewConsolidated, isLoading: permLoading } =
    useFinancePermission("finance.view_consolidated");

  const today = new Date();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(endOfMonth(today), "yyyy-MM-dd"));

  const [declBusiness, setDeclBusiness] = useState<string>("");
  const [declContact, setDeclContact] = useState<string>("");
  const [declCounterparty, setDeclCounterparty] = useState<string>("");

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
  const memberIds = useMemo(() => members.map((m) => m.business_id), [members]);
  const memberName = (id: string) =>
    members.find((m) => m.business_id === id)?.business_name ?? "—";

  const partnersQuery = useConsolidationIntercompanyPartners(groupId);
  const contactsQuery = useConsolidationMemberContacts(memberIds);
  const balancesQuery = useConsolidationIntercompanyBalances(
    canViewConsolidated && scopeIsClean ? groupId : null,
    dateFrom,
    dateTo,
  );
  const activityQuery = useConsolidationIntercompanyActivity(
    canViewConsolidated && scopeIsClean ? groupId : null,
    dateFrom,
    dateTo,
  );
  const coverageQuery = useConsolidationIntercompanyCoverage(
    canViewConsolidated && scopeIsClean ? groupId : null,
    dateFrom,
    dateTo,
  );
  const { declarePartner, closeDeclaration, deleteDeclaration } =
    useConsolidationIntercompanyMutations();



  const contactsForBusiness = useMemo(
    () => (contactsQuery.data ?? []).filter((c) => c.business_id === declBusiness),
    [contactsQuery.data, declBusiness],
  );
  const contactName = (id: string) =>
    (contactsQuery.data ?? []).find((c) => c.id === id)?.name ?? "—";

  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "declaring", header: "Company" },
      { key: "counterparty", header: "Counterparty" },
      { key: "due_from", header: "Says it is owed", align: "right" },
      { key: "due_to", header: "Counterparty says it owes", align: "right" },
      { key: "difference", header: "Difference", align: "right" },
      { key: "status", header: "Status" },
    ],
    [],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const money = (v: number) => formatAmount(Number(v), currency);
    return (balancesQuery.data ?? []).map((r, i) => ({
      id: `${r.declaring_business_id}:${r.counterparty_business_id}:${i}`,
      values: {
        declaring: r.declaring_business_name,
        counterparty: r.counterparty_business_name,
        due_from: money(r.declaring_amount),
        due_to: money(r.counterparty_amount),
        difference: money(r.difference),
        status: isReconciled(r) ? "Reconciled" : "Needs investigation",
      },
    }));
  }, [balancesQuery.data, currency]);

  // Activity, per group account: the dimension that lets an intercompany figure
  // be traced to the consolidated statement line it sits on.
  const activityColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "declaring", header: "Company" },
      { key: "counterparty", header: "Counterparty" },
      { key: "group_account", header: "Group account" },
      { key: "account", header: "Its account" },
      { key: "debit", header: "Debit", align: "right" },
      { key: "credit", header: "Credit", align: "right" },
      { key: "net", header: "Net", align: "right" },
      { key: "rate", header: "Rate" },
    ],
    [],
  );

  const activityRows = useMemo<ReportRow[]>(() => {
    const money = (v: number) => formatAmount(Number(v), currency);
    return (activityQuery.data ?? []).map((r) => ({
      id: `${r.declaring_business_id}:${r.counterparty_business_id}:${r.account_id}`,
      values: {
        declaring: r.declaring_business_name,
        counterparty: r.counterparty_business_name,
        group_account: r.group_account_code
          ? `${r.group_account_code} · ${r.group_account_name}`
          : "Unmapped",
        account: `${r.account_code} · ${r.account_name}`,
        debit: money(r.debit),
        credit: money(r.credit),
        net: money(r.net),
        rate: `${r.rate_class} @ ${Number(r.rate_used)}`,
      },
    }));
  }, [activityQuery.data, currency]);

  const coverageColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "business", header: "Company" },
      { key: "contact", header: "Undeclared contact" },
      { key: "receivable", header: "Receivable", align: "right" },
      { key: "payable", header: "Payable", align: "right" },
      { key: "activity", header: "Posted lines", align: "right" },
      { key: "suggestion", header: "Possible group company" },
    ],
    [],
  );

  const coverageRows = useMemo<ReportRow[]>(() => {
    return (coverageQuery.data ?? []).map((r) => ({
      id: `${r.business_id}:${r.contact_id}`,
      values: {
        business: `${r.business_name} (${r.base_currency})`,
        contact: r.contact_name,
        // Deliberately in the member's own currency: a worklist must never be
        // blocked by, or imply, a translation.
        receivable: formatAmount(Number(r.receivable_base), r.base_currency),
        payable: formatAmount(Number(r.payable_base), r.base_currency),
        activity: String(r.gl_line_count),
        suggestion: r.suggested_counterparty_business_name
          ? `${r.suggested_counterparty_business_name} — same ${
              r.suggestion_basis === "tax_id" ? "tax number" : "registration number"
            }`
          : "—",
      },
    }));
  }, [coverageQuery.data]);

  const suggestedCount = (coverageQuery.data ?? []).filter(
    (r) => r.suggested_counterparty_business_id,
  ).length;

  /**
   * One export per section. The three tables answer different questions and
   * carry different columns (and, for the worklist, different currencies), so
   * they are exported as separate artifacts rather than mashed into one sheet
   * where a reader could add up figures that are not comparable.
   *
   * Every export is derived from the same rows the screen renders — no figure is
   * recomputed for the export.
   */
  const period = `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`;
  const groupLabel = selectedGroup?.name ?? "Consolidation group";

  const buildConfig = useCallback(
    (
      title: string,
      subtitle: string,
      sheetName: string,
      cols: ReportColumn[],
      rws: ReportRow[],
      cur?: string,
    ): ExportConfig => ({
      title,
      subtitle,
      dateRange: period,
      columns: toExportColumns(cols as ReportColumn<never>[]),
      rows: toExportRows(rws, cols as ReportColumn<never>[]),
      sheetName,
      currency: cur,
      formatProfile: "financial",
    }),
    [period],
  );

  const getReconciliationExport = useCallback(
    (): ExportConfig =>
      buildConfig(
        "Intercompany Reconciliation",
        `${groupLabel} · declared pairs, restated into ${currency} at the group's closing rate · no eliminations produced`,
        "Intercompany",
        columns,
        rows,
        currency,
      ),
    [buildConfig, columns, rows, currency, groupLabel],
  );

  const getActivityExport = useCallback(
    (): ExportConfig =>
      buildConfig(
        "Intercompany Activity by Group Account",
        `${groupLabel} · read from the consolidated trial balance itself, so it cannot drift from the statement lines`,
        "IC by group account",
        activityColumns,
        activityRows,
        currency,
      ),
    [buildConfig, activityColumns, activityRows, currency, groupLabel],
  );

  const getCoverageExport = useCallback(
    (): ExportConfig =>
      buildConfig(
        "Undeclared Intercompany Activity",
        `${groupLabel} · trading partners with no declaration for the period · amounts in each company's OWN currency, untranslated`,
        "Undeclared",
        coverageColumns,
        coverageRows,
      ),
    [buildConfig, coverageColumns, coverageRows, groupLabel],
  );


  const unreconciled = (balancesQuery.data ?? []).filter((r) => !isReconciled(r));

  const submitDeclaration = async () => {
    if (!groupId || !declBusiness || !declContact || !declCounterparty) return;
    try {
      await declarePartner.mutateAsync({
        group_id: groupId,
        business_id: declBusiness,
        contact_id: declContact,
        counterparty_business_id: declCounterparty,
      });
      setDeclContact("");
      setDeclCounterparty("");
      toast.success("Intercompany relationship declared");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The declaration was rejected");
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
                    Intercompany reconciliation needs the{" "}
                    <strong>consolidated view</strong> finance permission, because it
                    exposes balances from every company in the group.
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
            <ArrowLeftRight className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">Intercompany Identification</h1>
            <p className="text-muted-foreground mt-1">
              Declare which customers and suppliers are in fact other companies in the
              group, then reconcile what each side has booked.
            </p>
          </div>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            Intercompany status is only ever what you declare here — it is never guessed
            from a name or an account code. Positions are read from the posted
            receivables and payables sub-ledgers and restated into{" "}
            <strong>{currency}</strong> at the group's closing rate.{" "}
            <strong>No elimination entries are produced</strong>: this screen identifies
            and reconciles intra-group balances, it does not yet remove them from the
            consolidated statements.
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
          <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
              <Label htmlFor="ic-from">From</Label>
              <Input
                id="ic-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ic-to">To</Label>
              <Input
                id="ic-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
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
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Declared relationships</CardTitle>
              <CardDescription>
                One declaration per contact. Ending a declaration keeps history intact so
                periods already reported still resolve the same way.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                <div className="space-y-1">
                  <Label>Company</Label>
                  <Select
                    value={declBusiness}
                    onValueChange={(v) => {
                      setDeclBusiness(v);
                      setDeclContact("");
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Member" />
                    </SelectTrigger>
                    <SelectContent>
                      {members.map((m) => (
                        <SelectItem key={m.business_id} value={m.business_id}>
                          {m.business_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Its contact</Label>
                  <Select
                    value={declContact}
                    onValueChange={setDeclContact}
                    disabled={!declBusiness}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Customer or supplier" />
                    </SelectTrigger>
                    <SelectContent>
                      {contactsForBusiness.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Is this member</Label>
                  <Select value={declCounterparty} onValueChange={setDeclCounterparty}>
                    <SelectTrigger>
                      <SelectValue placeholder="Counterparty" />
                    </SelectTrigger>
                    <SelectContent>
                      {members
                        .filter((m) => m.business_id !== declBusiness)
                        .map((m) => (
                          <SelectItem key={m.business_id} value={m.business_id}>
                            {m.business_name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={submitDeclaration}
                  disabled={
                    !declBusiness ||
                    !declContact ||
                    !declCounterparty ||
                    declarePartner.isPending
                  }
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Declare
                </Button>
              </div>

              {partnersQuery.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (partnersQuery.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No intercompany relationships declared yet. Until one is declared, no
                  intra-group balance can be identified.
                </p>
              ) : (
                <div className="divide-y rounded-md border">
                  {(partnersQuery.data ?? []).map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                    >
                      <span className="font-medium">{memberName(p.business_id)}</span>
                      <span className="text-muted-foreground">·</span>
                      <span>{contactName(p.contact_id)}</span>
                      <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium">
                        {memberName(p.counterparty_business_id)}
                      </span>
                      <Badge variant="outline" className="ml-2">
                        {p.effective_from}
                        {p.effective_to ? ` → ${p.effective_to}` : " → open"}
                      </Badge>
                      <div className="ml-auto flex gap-2">
                        {!p.effective_to && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              closeDeclaration.mutate({ id: p.id, effectiveTo: dateTo })
                            }
                          >
                            End as of {dateTo}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteDeclaration.mutate(p.id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {groupId && scopeIsClean && (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="space-y-1.5">
                <CardTitle className="text-base">Intercompany reconciliation</CardTitle>
                <CardDescription>
                  Each declared pair, in {currency}: the receivable one company carries
                  against the payable its counterparty carries back.
                </CardDescription>
              </div>
              {rows.length > 0 && !balancesQuery.error && (
                <ReportExportButtons getExportConfig={getReconciliationExport} compact />
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {balancesQuery.error ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    {balancesQuery.error instanceof Error
                      ? balancesQuery.error.message
                      : "This period cannot be reported."}
                  </AlertDescription>
                </Alert>
              ) : balancesQuery.isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No intra-group positions in this period for the declared relationships.
                </p>
              ) : (
                <>
                  {unreconciled.length > 0 && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        {unreconciled.length} intercompany pair
                        {unreconciled.length === 1 ? "" : "s"} disagree. Investigate the
                        difference — goods in transit, an unposted document, or a payment
                        recorded on one side only. Nothing is netted or written off here.
                      </AlertDescription>
                    </Alert>
                  )}
                  <ReportTable columns={columns} rows={rows} currency={currency} />
                </>
              )}
            </CardContent>
          </Card>
        )}

        {groupId && scopeIsClean && (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="space-y-1.5">
                <CardTitle className="text-base">
                  Intercompany activity by group account
                </CardTitle>
                <CardDescription>
                  The same declared relationships, broken out to the consolidated line each
                  figure sits on — including intercompany activity booked straight to the
                  ledger, such as recharges and intra-group loans, which never touches the
                  receivables or payables sub-ledgers.
                </CardDescription>
              </div>
              {activityRows.length > 0 && !activityQuery.error && (
                <ReportExportButtons getExportConfig={getActivityExport} compact />
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {activityQuery.error ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    {activityQuery.error instanceof Error
                      ? activityQuery.error.message
                      : "This period cannot be reported."}
                  </AlertDescription>
                </Alert>
              ) : activityQuery.isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : activityRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No posted intercompany ledger activity in this period for the declared
                  relationships.
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Accounts, group mappings and rates are read from the consolidated
                    trial balance itself, so these figures cannot drift from the statement
                    lines they belong to. Still no eliminations: nothing here is removed
                    from the consolidated statements.
                  </p>
                  <ReportTable
                    columns={activityColumns}
                    rows={activityRows}
                    currency={currency}
                  />
                </>
              )}
            </CardContent>
          </Card>
        )}

        {groupId && scopeIsClean && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Undeclared activity</CardTitle>
              <CardDescription>
                Because intercompany status is only ever declared, an undeclared
                relationship is invisible to every figure above. This worklist shows the
                trading partners of each member company that carry no declaration for the
                period, so the gap is reviewed rather than assumed away.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {coverageQuery.error ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    {coverageQuery.error instanceof Error
                      ? coverageQuery.error.message
                      : "This worklist cannot be produced."}
                  </AlertDescription>
                </Alert>
              ) : coverageQuery.isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : coverageRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Every trading partner with activity in this period is either declared as
                  a group company or has been reviewed and left as third party.
                </p>
              ) : (
                <>
                  {suggestedCount > 0 && (
                    <Alert>
                      <Info className="h-4 w-4" />
                      <AlertDescription>
                        {suggestedCount} undeclared contact
                        {suggestedCount === 1 ? " carries" : "s carry"} the same tax or
                        registration number as another company in the group. That is a
                        prompt to check, not a conclusion — nothing becomes intercompany
                        until you declare it above.
                      </AlertDescription>
                    </Alert>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Amounts are shown in each company's own currency and are not
                    translated, because nothing in this list is a reported figure. Names
                    are never used to suggest a match.
                  </p>
                  <ReportTable columns={coverageColumns} rows={coverageRows} />
                </>
              )}
            </CardContent>
          </Card>
        )}

      </div>
    </ReportsLayout>
  );
}
