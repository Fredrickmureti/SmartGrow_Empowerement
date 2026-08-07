/**
 * Bank Reconciliation Report
 *
 * Phase B3 — read-only report over `bank_reconciliation_sessions` joined
 * to `bank_accounts`. Rendered by the canonical reporting engine
 * (`@/design-system/reports`). The actual reconciliation workflow lives
 * at `/finance/reconciliation` and remains the only place to mutate
 * session state — this page is observation only.
 */

import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import {
  ReportSurface,
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";

type StatusFilter = "all" | "in_progress" | "completed" | "cancelled";

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

function BankReconciliationReportInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();
  const { baseCurrency } = useCurrency();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [accountId, setAccountId] = useState<string>("all");

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

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: [
      "bank-reconciliation-report",
      currentOrg?.id,
      currentBusiness?.id,
      scope.branchId,
      status, fromDate, toDate, accountId,
    ],
    enabled: !!currentOrg?.id,
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

  const kpis = useMemo(() => {
    const open = rows.filter((r) => r.status === "in_progress").length;
    const drift = rows.reduce((acc, r) => acc + Math.abs(r.difference ?? 0), 0);
    const reconciledTotal = rows
      .filter((r) => r.status === "completed")
      .reduce((acc, r) => acc + r.reconciled_balance, 0);
    return { open, drift, reconciledTotal, total: rows.length };
  }, [rows]);

  // ── One column + row declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn[]>(
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
      { key: "reconciled_balance", header: "Reconciled", format: "currency", width: "w-[140px]" },
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

  const tableRows = useMemo<ReportRow[]>(
    () => rows.map((r) => {
      const diff = r.difference ?? 0;
      const hasDrift = Math.abs(diff) > 0.01;
      return {
        id: r.id,
        tone: hasDrift ? "warning" : "default",
        values: {
          statement_date: r.statement_date,
          bank_account_name: r.bank_account_name,
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

  const getExportConfig = useCallback((): ExportConfig => ({
    title: "Bank Reconciliation Report",
    subtitle: "All reconciliation sessions with matched/unmatched picture",
    formatProfile: "financial",
    columns: toExportColumns(columns),
    rows: toExportRows(tableRows, columns),
    currency: baseCurrency,
  }), [columns, tableRows, baseCurrency]);

  return (
    <ReportPageLayout
      title="Bank Reconciliation Report"
      description="Every reconciliation session across all bank accounts in scope. Drill into a session to inspect matched lines, outstanding deposits, outstanding checks, and write-offs."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyState={{
        kind: "no_data",
        title: "No reconciliation sessions in scope",
        message:
          "No bank reconciliation session matches the selected bank accounts, statuses and date range.",
      }}
      getExportConfig={getExportConfig}
      filters={
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs">Bank account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard label="Sessions" value={String(kpis.total)} />
          <KpiCard label="Open" value={String(kpis.open)} />
          <KpiCard label="Reconciled balance (completed)" value={kpis.reconciledTotal.toFixed(2)} />
          <KpiCard label="Σ |difference|" value={kpis.drift.toFixed(2)} tone={kpis.drift > 0.01 ? "warn" : "ok"} />
        </div>

        <ReportSurface
          title="Bank Reconciliation Sessions"
          subtitle="Matched / unmatched picture across every reconciliation session"
          profile="operational"
        >
          <ReportTable
            columns={columns}
            rows={tableRows}
            currency={baseCurrency}
            caption="Bank reconciliation sessions"
            emptyMessage="No reconciliation sessions found for the selected filters."
          />
        </ReportSurface>
      </div>
    </ReportPageLayout>
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
