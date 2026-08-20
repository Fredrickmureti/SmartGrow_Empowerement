/**
 * Bank Reconciliation Report
 *
 * Two views over one domain:
 *
 *  1. Statement — the accountant's bank-to-book proof for one account at one
 *     date. Every figure comes from `finance_bank_reconciliation_statement`
 *     via `@/services/finance/bankReconciliationStatement`; this file performs
 *     no accounting arithmetic and no classification of its own.
 *  2. Sessions — the register of reconciliation sessions (read-only). The
 *     workflow itself lives at `/finance/reconciliation` and remains the only
 *     place to mutate session state.
 */

import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ArrowRight, AlertTriangle, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import type { ExportConfig, ServerBuildConfig } from "@/services/reports/ReportExportService";
import {
  ReportSurface,
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import {
  fetchBankReconciliationStatement,
  type ReconciliationItemGroup,
} from "@/services/finance/bankReconciliationStatement";

type StatusFilter = "all" | "in_progress" | "completed" | "cancelled";
type ViewMode = "statement" | "sessions";

interface SessionRow {
  id: string;
  statement_date: string;
  status: "in_progress" | "completed" | "cancelled";
  opening_balance: number;
  closing_balance: number;
  reconciled_balance: number;
  difference: number | null;
  completed_at: string | null;
  bank_account_id: string;
  bank_account_name: string;
  bank_account_branch_id: string | null;
  bank_account_currency: string | null;
}

const STATUS_VARIANT: Record<SessionRow["status"], "default" | "secondary" | "outline" | "destructive"> = {
  in_progress: "secondary",
  completed: "default",
  cancelled: "outline",
};

const STATUS_LABEL: Record<SessionRow["status"], string> = {
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

const todayIso = () => new Date().toISOString().slice(0, 10);

function BankReconciliationReportInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();
  const { baseCurrency } = useCurrency();

  const [view, setView] = useState<ViewMode>("statement");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [accountId, setAccountId] = useState<string>("all");
  const [asOf, setAsOf] = useState<string>(todayIso);

  const { data: accounts = [] } = useQuery({
    queryKey: ["bank-accounts-for-rec-report", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      let q = supabase
        .from("bank_accounts")
        .select("id, name, currency, branch_id")
        .eq("organization_id", currentOrg!.id)
        .order("name");
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  // The proof is per account: fall back to the first account in scope.
  const statementAccountId =
    accountId !== "all" ? accountId : (accounts[0]?.id ?? null);

  const {
    data: statement,
    isLoading: statementLoading,
    error: statementError,
  } = useQuery({
    queryKey: [
      "bank-reconciliation-statement",
      currentOrg?.id, currentBusiness?.id, scope.branchId, statementAccountId, asOf,
    ],
    enabled: view === "statement" && !!currentOrg?.id && !!statementAccountId && !!asOf,
    queryFn: () =>
      fetchBankReconciliationStatement({
        orgId: currentOrg!.id,
        bankAccountId: statementAccountId!,
        asOf,
        businessId: currentBusiness?.id ?? null,
        branchId: scope.branchId ?? null,
      }),
  });

  const { data: rows = [], isLoading: sessionsLoading, error: sessionsError } = useQuery({
    queryKey: [
      "bank-reconciliation-report",
      currentOrg?.id,
      currentBusiness?.id,
      scope.branchId,
      status, fromDate, toDate, accountId,
    ],
    enabled: view === "sessions" && !!currentOrg?.id,
    queryFn: async (): Promise<SessionRow[]> => {
      let q = supabase
        .from("bank_reconciliation_sessions")
        .select(`
          id, statement_date, status, opening_balance, closing_balance,
          reconciled_balance, difference, completed_at, bank_account_id,
          bank_account:bank_accounts!bank_reconciliation_sessions_bank_account_id_fkey (
            id, name, branch_id, currency
          )
        `)
        .eq("organization_id", currentOrg!.id)
        .order("statement_date", { ascending: false });
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      if (scope.branchId) {
        q = q.or(`branch_id.eq.${scope.branchId},branch_id.is.null`);
      }
      if (status !== "all") q = q.eq("status", status);
      if (fromDate) q = q.gte("statement_date", fromDate);
      if (toDate) q = q.lte("statement_date", toDate);
      if (accountId !== "all") q = q.eq("bank_account_id", accountId);

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((r: Record<string, unknown>) => {
        const ba = (r.bank_account ?? {}) as Record<string, unknown>;
        return {
          id: r.id as string,
          statement_date: r.statement_date as string,
          status: r.status as SessionRow["status"],
          opening_balance: Number(r.opening_balance ?? 0),
          closing_balance: Number(r.closing_balance ?? 0),
          reconciled_balance: Number(r.reconciled_balance ?? 0),
          difference: r.difference == null ? null : Number(r.difference),
          completed_at: (r.completed_at as string | null) ?? null,
          bank_account_id: r.bank_account_id as string,
          bank_account_name: (ba.name as string) ?? "—",
          bank_account_branch_id: (ba.branch_id as string | null) ?? null,
          bank_account_currency: (ba.currency as string | null) ?? null,
        };
      });
    },
  });

  // Counts only: sessions span bank accounts in different currencies, so no
  // money total across the register would mean anything.
  const kpis = useMemo(() => {
    const open = rows.filter((r) => r.status === "in_progress").length;
    const completed = rows.filter((r) => r.status === "completed").length;
    const withDifference = rows.filter((r) => Math.abs(r.difference ?? 0) > 0.01).length;
    return { open, completed, withDifference, total: rows.length };
  }, [rows]);

  // ── Sessions register: one declaration drives the table AND the export ──
  const sessionColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "statement_date", header: "Statement Date", format: "date", width: "w-[130px]" },
      { key: "bank_account_name", header: "Bank Account", width: "w-[220px]" },
      {
        key: "status",
        header: "Status",
        width: "w-[120px]",
        render: (row) => {
          const r = row as unknown as ReportRow;
          const s = r.values?.status as SessionRow["status"] | undefined;
          if (!s) return null;
          return <Badge variant={STATUS_VARIANT[s]}>{STATUS_LABEL[s]}</Badge>;
        },
      },
      { key: "opening_balance", header: "Opening", format: "currency", width: "w-[140px]" },
      { key: "closing_balance", header: "Statement Close", format: "currency", width: "w-[150px]" },
      { key: "bank_account_currency", header: "Currency", width: "w-[90px]" },
      { key: "reconciled_balance", header: "Cleared Movement", format: "currency", width: "w-[160px]" },
      { key: "difference", header: "Difference", format: "currency", width: "w-[130px]" },
      {
        key: "actions",
        header: "",
        exportExclude: true,
        width: "w-[120px]",
        render: (row) => {
          const r = row as unknown as ReportRow;
          return (
            <Button asChild variant="outline" size="sm">
              <Link to={`/finance/reconciliation?session=${r.id}`}>
                Open <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          );
        },
      },
    ],
    [],
  );

  const sessionRows = useMemo<ReportRow[]>(
    () => rows.map((r) => {
      const diff = r.difference ?? 0;
      const hasDrift = Math.abs(diff) > 0.01;
      return {
        id: r.id,
        tone: hasDrift ? "warning" : "default",
        values: {
          statement_date: r.statement_date,
          bank_account_name: r.bank_account_name,
          bank_account_currency: r.bank_account_currency ?? "—",
          status: r.status,
          opening_balance: r.opening_balance,
          closing_balance: r.closing_balance,
          reconciled_balance: r.reconciled_balance,
          difference: diff,
        },
      } satisfies ReportRow;
    }),
    [rows],
  );

  // ── Statement: the proof itself, rendered verbatim from the engine ──
  const proofColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "line", header: "Line" },
      { key: "amount", header: "Amount", format: "currency", align: "right", width: "w-[180px]" },
    ],
    [],
  );

  const proofRows = useMemo<ReportRow[]>(() => {
    if (!statement) return [];
    const b = statement.bank;
    const k = statement.book;
    const out: ReportRow[] = [
      { id: "bank-head", kind: "subsection", values: { line: "Balance per bank statement", amount: b.statementBalance } },
      { id: "dit", values: { line: b.depositsInTransit.label, amount: b.depositsInTransit.total } },
      { id: "unp", values: { line: b.unpresentedPayments.label, amount: -b.unpresentedPayments.total } },
      { id: "bank-adj", kind: "subtotal", values: { line: "Adjusted bank balance", amount: b.adjustedBalance } },
      { id: "book-head", kind: "subsection", values: { line: "Balance per books (general ledger)", amount: k.glBalance } },
      { id: "unrec-in", values: { line: k.unrecordedReceipts.label, amount: k.unrecordedReceipts.total } },
      { id: "unrec-out", values: { line: k.unrecordedCharges.label, amount: -k.unrecordedCharges.total } },
      { id: "book-adj", kind: "subtotal", values: { line: "Adjusted book balance", amount: k.adjustedBalance } },
      {
        id: "residual",
        kind: "calculatedResult",
        tone: statement.inBalance ? "default" : "warning",
        values: { line: "Unexplained difference", amount: statement.residual },
      },
    ];
    return out;
  }, [statement]);

  const itemColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "date", header: "Date", format: "date", width: "w-[120px]" },
      { key: "reference", header: "Reference", width: "w-[160px]" },
      { key: "description", header: "Description" },
      { key: "amount", header: "Amount", format: "currency", align: "right", width: "w-[160px]" },
    ],
    [],
  );

  const groupRows = useCallback(
    (group: ReconciliationItemGroup): ReportRow[] =>
      group.items.map((item) => ({
        id: item.id,
        values: {
          date: item.date,
          reference: item.reference ?? "—",
          description: item.description ?? "—",
          amount: item.amount,
        },
      })),
    [],
  );

  const statementCurrency = statement?.currency || baseCurrency;

  const getExportConfig = useCallback((): ServerBuildConfig => {
    if (view === "sessions") {
      return {
        title: "Bank Reconciliation Sessions",
        subtitle: "All reconciliation sessions with matched/unmatched picture",
        formatProfile: "financial",
        columns: toExportColumns(sessionColumns),
        rows: toExportRows(sessionRows, sessionColumns),
        currency: baseCurrency,
      };
    }
    // Statement tab: the export is REBUILT server-side from the same
    // `finance_bank_reconciliation_statement` engine, so the archived proof
    // is the engine's, not the screen's (which caps item lists at 200).
    return {
      title: "Bank Reconciliation Statement",
      subtitle: statement
        ? `${statement.account.name} — as at ${statement.asOf}`
        : "Bank-to-book proof",
      // Without an account there is no proof to rebuild; fall back to the
      // page rows rather than asking the engine to guess an account.
      ...(statementAccountId
        ? {
            reportType: "bank_reconciliation",
            organizationId: currentOrg?.id,
            dateFrom: asOf,
            dateTo: asOf,
            filters: { bankAccountId: statementAccountId },
          }
        : { formatProfile: "financial" as const }),
      businessId: currentBusiness?.id,
      branchId: scope.branchId ?? null,
      asOf,

      columns: toExportColumns(proofColumns),
      rows: toExportRows(proofRows, proofColumns),
      currency: statementCurrency,
    };
  }, [
    view, sessionColumns, sessionRows, baseCurrency, statement, proofColumns, proofRows,
    statementCurrency, currentOrg, currentBusiness, scope.branchId, asOf, statementAccountId,
  ]);


  const isLoading = view === "statement" ? statementLoading : sessionsLoading;
  const error = (view === "statement" ? statementError : sessionsError) as Error | null;
  const isEmpty =
    view === "statement"
      ? !statementLoading && !statement && accounts.length === 0
      : !sessionsLoading && rows.length === 0;

  return (
    <ReportPageLayout
      title="Bank Reconciliation"
      description="Prove the bank balance against the ledger at a date, then review every reconciliation session behind it."
      isLoading={isLoading}
      error={error ?? null}
      isEmpty={isEmpty}
      emptyState={{
        kind: "no_data",
        title: view === "statement" ? "No bank account in scope" : "No reconciliation sessions in scope",
        message:
          view === "statement"
            ? "Add a bank account to this business to produce a reconciliation statement."
            : "No bank reconciliation session matches the selected bank accounts, statuses and date range.",
      }}
      getExportConfig={getExportConfig}
      filters={
        <div className="space-y-3">
          <Tabs value={view} onValueChange={(v) => setView(v as ViewMode)}>
            <TabsList>
              <TabsTrigger value="statement">Statement</TabsTrigger>
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs">Bank account</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {view === "sessions" && <SelectItem value="all">All accounts</SelectItem>}
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {view === "statement" ? (
              <div>
                <Label className="text-xs">As at</Label>
                <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
              </div>
            ) : (
              <>
                <div>
                  <Label className="text-xs">Status</Label>
                  <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="in_progress">In progress</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
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
              </>
            )}
          </div>
        </div>
      }
    >
      {view === "statement" ? (
        <div className="space-y-4">
          {statement && (
            <>
              {statement.diagnostics.glAccountMissing && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>No ledger account linked</AlertTitle>
                  <AlertDescription>
                    This bank account has no general ledger account, so the book side of the
                    proof cannot be produced. Link a ledger account on the bank account record.
                  </AlertDescription>
                </Alert>
              )}
              {statement.diagnostics.glAccountShared && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Ledger account shared with another bank account</AlertTitle>
                  <AlertDescription>
                    More than one open bank account posts to this ledger account, so ledger
                    movement cannot be attributed to a single account. Give each bank account
                    its own ledger account to restore the proof.
                  </AlertDescription>
                </Alert>
              )}
              {!statement.inBalance
                && !statement.diagnostics.glAccountMissing
                && !statement.diagnostics.glAccountShared && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Statement does not reconcile</AlertTitle>
                  <AlertDescription>
                    An unexplained difference of {statement.residual?.toFixed(2)} {statement.currency} remains
                    after outstanding and unrecorded items. Investigate duplicate or missing
                    postings before closing the period.
                  </AlertDescription>
                </Alert>
              )}
              {statement.inBalance && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>Reconciled</AlertTitle>
                  <AlertDescription>
                    The adjusted bank balance agrees with the adjusted book balance as at {statement.asOf}.
                  </AlertDescription>
                </Alert>
              )}
              {statement.diagnostics.clearedWithoutPosting > 0 && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Cleared lines with no posting</AlertTitle>
                  <AlertDescription>
                    {statement.diagnostics.clearedWithoutPosting} statement line(s) are marked
                    reconciled but carry no journal entry.
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard label="Balance per bank" value={statement.bank.statementBalance.toFixed(2)} />
                <KpiCard label="Adjusted bank" value={statement.bank.adjustedBalance.toFixed(2)} />
                <KpiCard
                  label="Adjusted book"
                  value={statement.book.adjustedBalance == null ? "—" : statement.book.adjustedBalance.toFixed(2)}
                />
                <KpiCard
                  label="Unexplained difference"
                  value={statement.residual == null ? "—" : statement.residual.toFixed(2)}
                  tone={statement.inBalance ? "ok" : "warn"}
                />
              </div>

              <ReportSurface
                title={`Reconciliation statement — ${statement.account.name}`}
                subtitle={`As at ${statement.asOf}${statement.account.glAccountCode ? ` · GL ${statement.account.glAccountCode}` : ""}`}
                profile="financial"
              >
                <ReportTable
                  columns={proofColumns}
                  rows={proofRows}
                  currency={statementCurrency}
                  caption="Bank reconciliation statement"
                  emptyMessage="No statement could be produced for this account and date."
                />
              </ReportSurface>

              <ItemSurface
                title="Deposits in transit"
                subtitle="Recorded in the books, not yet on the statement"
                group={statement.bank.depositsInTransit}
                columns={itemColumns}
                rows={groupRows(statement.bank.depositsInTransit)}
                currency={statementCurrency}
              />
              <ItemSurface
                title="Unpresented payments"
                subtitle="Recorded in the books, not yet on the statement"
                group={statement.bank.unpresentedPayments}
                columns={itemColumns}
                rows={groupRows(statement.bank.unpresentedPayments)}
                currency={statementCurrency}
              />
              <ItemSurface
                title="Unrecorded receipts"
                subtitle="On the statement, not yet in the books"
                group={statement.book.unrecordedReceipts}
                columns={itemColumns}
                rows={groupRows(statement.book.unrecordedReceipts)}
                currency={statementCurrency}
              />
              <ItemSurface
                title="Unrecorded charges"
                subtitle="On the statement, not yet in the books"
                group={statement.book.unrecordedCharges}
                columns={itemColumns}
                rows={groupRows(statement.book.unrecordedCharges)}
                currency={statementCurrency}
              />

              {statement.diagnostics.latestSession && (
                <div className="text-xs text-muted-foreground">
                  Latest session at {statement.diagnostics.latestSession.statementDate} is{" "}
                  {statement.diagnostics.latestSession.status.replace("_", " ")}.{" "}
                  <Link
                    className="underline"
                    to={`/finance/reconciliation?session=${statement.diagnostics.latestSession.id}`}
                  >
                    Open session
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard label="Sessions" value={String(kpis.total)} />
            <KpiCard label="Open" value={String(kpis.open)} />
            <KpiCard label="Completed" value={String(kpis.completed)} />
            <KpiCard
              label="With a difference"
              value={String(kpis.withDifference)}
              tone={kpis.withDifference > 0 ? "warn" : "ok"}
            />
          </div>

          <ReportSurface
            title="Bank Reconciliation Sessions"
            subtitle="Matched / unmatched picture across every reconciliation session"
            profile="operational"
          >
            <ReportTable
              columns={sessionColumns}
              rows={sessionRows}
              currency={baseCurrency}
              caption="Bank reconciliation sessions"
              emptyMessage="No reconciliation sessions found for the selected filters."
            />
          </ReportSurface>
        </div>
      )}
    </ReportPageLayout>
  );
}

function ItemSurface({
  title, subtitle, group, columns, rows, currency,
}: {
  title: string;
  subtitle: string;
  group: ReconciliationItemGroup;
  columns: ReportColumn[];
  rows: ReportRow[];
  currency: string;
}) {
  return (
    <ReportSurface
      title={`${title} (${group.count})`}
      subtitle={`${subtitle}${group.truncated ? " · showing the first 200 items" : ""}`}
      profile="operational"
    >
      <ReportTable
        columns={columns}
        rows={rows}
        currency={currency}
        caption={title}
        emptyMessage="None."
      />
    </ReportSurface>
  );
}

function KpiCard({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold tabular-nums ${tone === "warn" ? "text-amber-700" : ""}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

export default function BankReconciliationReport() {
  return (
    <ReportFilterProvider>
      <BankReconciliationReportInner />
    </ReportFilterProvider>
  );
}
