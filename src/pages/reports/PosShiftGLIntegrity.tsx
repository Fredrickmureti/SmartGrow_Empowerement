/**
 * POS Shift GL Integrity Report
 *
 * Phase B4 — surfaces every POS shift with its GL posting status and any
 * close-time errors. Sources:
 *   - `pos_shifts`              (one row per shift, with `journal_entry_id`
 *                                + `gl_posted_at` once GL posting succeeds)
 *   - `pos_shift_close_errors`  (append-only error log per shift)
 *   - RPC `get_pos_shift_gl_summary(p_shift_id)` for the per-shift debit /
 *     credit rollup, rendered on expand.
 *
 * This is a finance-audit report (category `audit`): observation only, no
 * mutations. The actual close / reopen workflows live under the POS app.
 *
 * Scoping: org + business + branch (POS shifts carry `branch_id` via the
 * register, so the branch filter is meaningful — registered in
 * `branchScopability.ts` as `pos_shift_gl_integrity`).
 */

import { Fragment, useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronRight, AlertTriangle, ArrowRight, Loader2, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";
import type {
  ExportConfig, ExportColumn, ExportRow,
} from "@/services/reports/ReportExportService";

type StatusFilter = "all" | "clean" | "errors" | "not_posted" | "posted";

interface ShiftRow {
  id: string;
  shift_number: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
  total_sales: number;
  total_returns: number;
  total_transactions: number;
  cash_difference: number | null;
  journal_entry_id: string | null;
  gl_posted_at: string | null;
  register_id: string;
  branch_id: string;
  register_name: string;
  error_count: number;
}

function fmtMoney(n: number | null | undefined, ccy: string) {
  const v = typeof n === "number" ? n : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: ccy, maximumFractionDigits: 2,
    }).format(v);
  } catch { return v.toFixed(2); }
}

function PosShiftGLIntegrityInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();
  const { baseCurrency } = useCurrency();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [registerId, setRegisterId] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: registers = [] } = useQuery({
    queryKey: ["pos-registers-for-integrity", currentOrg?.id, currentBusiness?.id, scope.branchId],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      let q = supabase
        .from("pos_registers")
        .select("id, register_name, branch_id")
        .eq("organization_id", currentOrg!.id)
        .order("name");
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      if (scope.branchId) q = q.eq("branch_id", scope.branchId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: [
      "pos-shift-gl-integrity",
      currentOrg?.id, currentBusiness?.id, scope.branchId,
      status, registerId, fromDate, toDate,
    ],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<ShiftRow[]> => {
      let q = supabase
        .from("pos_shifts")
        .select(`
          id, shift_number, status, opened_at, closed_at,
          total_sales, total_returns, total_transactions, cash_difference,
          journal_entry_id, gl_posted_at, register_id, branch_id,
          register:pos_registers!pos_shifts_register_id_fkey (id, register_name)
        `)
        .eq("organization_id", currentOrg!.id)
        .order("opened_at", { ascending: false })
        .limit(500);
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      if (scope.branchId) q = q.eq("branch_id", scope.branchId);
      if (registerId !== "all") q = q.eq("register_id", registerId);
      if (fromDate) q = q.gte("opened_at", `${fromDate}T00:00:00`);
      if (toDate) q = q.lte("opened_at", `${toDate}T23:59:59`);

      if (status === "posted") q = q.not("gl_posted_at", "is", null);
      if (status === "not_posted") {
        q = q.is("gl_posted_at", null).eq("status", "closed");
      }

      const { data, error } = await q;
      if (error) throw error;
      const shiftRows = (data ?? []).map((r: Record<string, unknown>) => {
        const reg = (r.register ?? {}) as Record<string, unknown>;
        return {
          id: r.id as string,
          shift_number: (r.shift_number as string) ?? "—",
          status: (r.status as string) ?? "—",
          opened_at: r.opened_at as string,
          closed_at: (r.closed_at as string | null) ?? null,
          total_sales: Number(r.total_sales ?? 0),
          total_returns: Number(r.total_returns ?? 0),
          total_transactions: Number(r.total_transactions ?? 0),
          cash_difference: r.cash_difference == null ? null : Number(r.cash_difference),
          journal_entry_id: (r.journal_entry_id as string | null) ?? null,
          gl_posted_at: (r.gl_posted_at as string | null) ?? null,
          register_id: r.register_id as string,
          branch_id: r.branch_id as string,
          register_name: (reg.register_name as string) ?? "—",
          error_count: 0,
        } as ShiftRow;
      });

      const ids = shiftRows.map((s) => s.id);
      if (ids.length === 0) return shiftRows;
      const { data: errs, error: errErr } = await supabase
        .from("pos_shift_close_errors")
        .select("shift_id")
        .in("shift_id", ids);
      if (errErr) throw errErr;
      const counts = new Map<string, number>();
      for (const e of errs ?? []) {
        counts.set(e.shift_id as string, (counts.get(e.shift_id as string) ?? 0) + 1);
      }
      for (const s of shiftRows) s.error_count = counts.get(s.id) ?? 0;

      // Apply derived filters after enrichment
      if (status === "clean") return shiftRows.filter((s) => s.error_count === 0 && !!s.gl_posted_at);
      if (status === "errors") return shiftRows.filter((s) => s.error_count > 0);
      return shiftRows;
    },
  });

  const kpis = useMemo(() => {
    const total = rows.length;
    const errors = rows.filter((r) => r.error_count > 0).length;
    const unposted = rows.filter((r) => r.status === "closed" && !r.gl_posted_at).length;
    const drift = rows.reduce((acc, r) => acc + Math.abs(r.cash_difference ?? 0), 0);
    return { total, errors, unposted, drift };
  }, [rows]);

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "shift_number", header: "Shift", width: 18 },
      { key: "register_name", header: "Register", width: 24 },
      { key: "opened_at", header: "Opened", width: 20 },
      { key: "closed_at", header: "Closed", width: 20 },
      { key: "status", header: "Status", width: 14 },
      { key: "total_sales", header: "Sales", width: 16, format: "currency", align: "right" },
      { key: "total_returns", header: "Returns", width: 16, format: "currency", align: "right" },
      { key: "cash_difference", header: "Cash diff.", width: 16, format: "currency", align: "right" },
      { key: "gl_posted", header: "GL posted", width: 14 },
      { key: "error_count", header: "Errors", width: 10, align: "right" },
    ];
    const exportRows: ExportRow[] = rows.map((r) => ({
      shift_number: r.shift_number,
      register_name: r.register_name,
      opened_at: r.opened_at ? format(new Date(r.opened_at), "yyyy-MM-dd HH:mm") : "",
      closed_at: r.closed_at ? format(new Date(r.closed_at), "yyyy-MM-dd HH:mm") : "",
      status: r.status,
      total_sales: r.total_sales,
      total_returns: r.total_returns,
      cash_difference: r.cash_difference ?? 0,
      gl_posted: r.gl_posted_at ? "Yes" : "No",
      error_count: r.error_count,
    }));
    return {
      title: "POS Shift GL Integrity",
      subtitle: "Per-shift GL posting status and close-time errors",
      columns,
      rows: exportRows,
      currency: baseCurrency,
    };
  }, [rows, baseCurrency]);

  return (
    <ReportPageLayout
      title="POS Shift GL Integrity"
      description="Per-shift snapshot of GL posting status and any close-time errors. Use this report to find shifts that closed but did not post to the GL, or that posted with errors that need investigation."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No POS shifts match the selected filters."
      getExportConfig={getExportConfig}
      filters={
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs">Register</Label>
            <Select value={registerId} onValueChange={setRegisterId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All registers</SelectItem>
                {registers.map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.register_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Integrity</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="clean">Clean (posted, no errors)</SelectItem>
                <SelectItem value="errors">Has close errors</SelectItem>
                <SelectItem value="not_posted">Closed but not posted</SelectItem>
                <SelectItem value="posted">Posted to GL</SelectItem>
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
          <KpiCard label="Shifts" value={String(kpis.total)} />
          <KpiCard label="With close errors" value={String(kpis.errors)} tone={kpis.errors > 0 ? "warn" : "ok"} />
          <KpiCard label="Closed, not posted" value={String(kpis.unposted)} tone={kpis.unposted > 0 ? "warn" : "ok"} />
          <KpiCard label="Σ |cash diff.|" value={fmtMoney(kpis.drift, baseCurrency)} />
        </div>

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px]"></TableHead>
                  <TableHead>Shift</TableHead>
                  <TableHead>Register</TableHead>
                  <TableHead>Opened</TableHead>
                  <TableHead>Closed</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="text-right">Cash diff.</TableHead>
                  <TableHead>GL</TableHead>
                  <TableHead>Errors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const isOpen = expanded === r.id;
                  const drift = Math.abs(r.cash_difference ?? 0) > 0.01;
                  const isProblem = r.error_count > 0 || (r.status === "closed" && !r.gl_posted_at);
                  return (
                    <Fragment key={r.id}>
                      <TableRow
                        className={`cursor-pointer ${isProblem ? "bg-amber-50/40 dark:bg-amber-950/10" : ""}`}
                        onClick={() => setExpanded(isOpen ? null : r.id)}
                      >
                        <TableCell>
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.shift_number}</TableCell>
                        <TableCell>{r.register_name}</TableCell>
                        <TableCell className="text-xs">{r.opened_at ? format(new Date(r.opened_at), "yyyy-MM-dd HH:mm") : "—"}</TableCell>
                        <TableCell className="text-xs">{r.closed_at ? format(new Date(r.closed_at), "yyyy-MM-dd HH:mm") : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMoney(r.total_sales, baseCurrency)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${drift ? "text-amber-700 font-medium" : "text-muted-foreground"}`}>
                          {fmtMoney(r.cash_difference, baseCurrency)}
                        </TableCell>
                        <TableCell>
                          {r.gl_posted_at ? (
                            <Badge variant="default">Posted</Badge>
                          ) : r.status === "closed" ? (
                            <Badge variant="destructive">Missing</Badge>
                          ) : (
                            <Badge variant="outline">Open</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {r.error_count > 0 ? (
                            <Badge variant="destructive" className="gap-1">
                              <AlertTriangle className="h-3 w-3" /> {r.error_count}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow>
                          <TableCell colSpan={9} className="bg-muted/30">
                            <ShiftDetail
                              shiftId={r.id}
                              journalEntryId={r.journal_entry_id}
                              currency={baseCurrency}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
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

function ShiftDetail({
  shiftId, journalEntryId, currency,
}: { shiftId: string; journalEntryId: string | null; currency: string }) {
  const summary = useQuery({
    queryKey: ["pos-shift-gl-summary", shiftId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_pos_shift_gl_summary", { p_shift_id: shiftId });
      if (error) throw error;
      return data as unknown;
    },
  });
  const errs = useQuery({
    queryKey: ["pos-shift-close-errors", shiftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pos_shift_close_errors")
        .select("id, occurred_at, error_message, error_detail")
        .eq("shift_id", shiftId)
        .order("occurred_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="space-y-3 py-2">
      {journalEntryId && (
        <div>
          <Button asChild variant="outline" size="sm">
            <Link to={`/finance/journal-entries/${journalEntryId}`}>
              View posted journal entry <ArrowRight className="h-3 w-3 ml-1" />
            </Link>
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardContent className="pt-4 space-y-2">
            <div className="text-xs font-semibold uppercase text-muted-foreground">GL Summary</div>
            {summary.isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
            {summary.error && (
              <div className="text-xs text-destructive">{(summary.error as Error).message}</div>
            )}
            {summary.data != null && (
              <pre className="text-xs whitespace-pre-wrap bg-muted/40 rounded p-2 max-h-80 overflow-auto">
                {JSON.stringify(summary.data, null, 2)}
              </pre>
            )}
            {summary.data == null && !summary.isLoading && !summary.error && (
              <div className="text-xs text-muted-foreground">No GL summary returned (shift not posted).</div>
            )}
            <div className="text-[10px] text-muted-foreground">Currency: {currency}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 space-y-2">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Close Errors</div>
            {errs.isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
            {(errs.data ?? []).length === 0 && !errs.isLoading && (
              <div className="text-xs text-muted-foreground">No close errors recorded.</div>
            )}
            <ul className="space-y-2">
              {(errs.data ?? []).map((e) => (
                <li key={e.id as string} className="text-xs border rounded p-2 bg-background">
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {e.occurred_at ? format(new Date(e.occurred_at as string), "yyyy-MM-dd HH:mm:ss") : ""}
                  </div>
                  <div className="font-medium">{e.error_message as string}</div>
                  {e.error_detail != null && (
                    <pre className="mt-1 text-[10px] whitespace-pre-wrap text-muted-foreground">
                      {JSON.stringify(e.error_detail, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function PosShiftGLIntegrity() {
  return (
    <ReportFilterProvider>
      <PosShiftGLIntegrityInner />
    </ReportFilterProvider>
  );
}
