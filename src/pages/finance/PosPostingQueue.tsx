/**
 * POS Posting Queue — operational workspace for the accountant.
 *
 * Purpose
 * -------
 * The POS shift close pipeline is asynchronous: `close_pos_statement`
 * enqueues a `pos.statement.posting.requested` event onto
 * `business_event_outbox`; the dispatcher then calls the authoritative
 * `post_pos_statement_gl` service function. When mappings are missing or
 * a downstream RPC raises, the outbox row accumulates `attempts` and
 * `last_error`, but nothing surfaces to the accountant.
 *
 * This page is the operational surface for that queue. It shows every
 * POS statement that has closed but not yet posted (or that is currently
 * failing in the outbox), a dry-run posting preview computed by the SAME
 * resolver chain as the poster (`get_pos_statement_posting_preview`), and
 * a permission-gated retry action (`retry_pos_statement_posting`) that
 * re-enqueues the outbox event.
 *
 * Reporting integrity vs. operations
 * ----------------------------------
 * The POS Shift GL Integrity report (Insights → Reports) is read-only;
 * every mutation lives here. The two surfaces MUST agree on unmapped
 * accounts — they do, because both consume the same resolver.
 */

import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Alert, AlertDescription, AlertTitle,
} from "@/components/ui/alert";
import {
  AlertTriangle, ArrowRight, Loader2, RefreshCw, Send,
  CheckCircle2, Clock, ShieldAlert,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useCurrency } from "@/hooks/useCurrency";
import { PageHeader } from "@/components/layout/page";

// ---------------------------------------------------------------------------
// Types

interface QueueRow {
  id: string;
  statement_number: string | null;
  shift_id: string | null;
  business_id: string;
  branch_id: string | null;
  organization_id: string;
  posting_status: string;
  close_kind: string;
  closed_at: string | null;
  journal_entry_id: string | null;
  total_sales: number;
  total_returns: number;
  total_tax: number;
  outbox_attempts: number;
  outbox_last_error: string | null;
  outbox_updated_at: string | null;
  dead_at: string | null;
  dead_reason: string | null;
  retry_count: number;
  last_retry_at: string | null;
}

interface PreviewUnresolved {
  kind: string;
  key: string;
  amount: number;
  hint: string;
}

interface AccountRef {
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  resolved: boolean;
}

interface PreviewTender extends AccountRef {
  tender_method: string;
  processor: string | null;
  tender_kind: string | null;
  net_amount: number;
  gross_amount: number;
  refund_amount: number;
}

interface PreviewData {
  statement_id: string;
  statement_number: string | null;
  shift_id: string | null;
  posting_status: string;
  close_kind: string;
  closed_at: string | null;
  journal_entry_id: string | null;
  total_sales: number;
  total_returns: number;
  total_tax: number;
  total_tip: number;
  net_revenue: number;
  tenders: PreviewTender[];
  revenue: (AccountRef & { amount: number }) | null;
  tax: (AccountRef & { amount: number }) | null;
  tip: (AccountRef & { amount: number; optional?: boolean }) | null;
  unresolved: PreviewUnresolved[];
  total_debit: number;
  total_credit: number;
  balanced: boolean;
  ready_to_post: boolean;
}

function fmtAccount(a: AccountRef | null | undefined): string {
  if (!a || !a.account_id) return "—";
  if (a.account_code && a.account_name) return `${a.account_code} — ${a.account_name}`;
  return a.account_name || a.account_code || a.account_id.slice(0, 8) + "…";
}

function fmtMoney(n: number | null | undefined, ccy: string) {
  const v = typeof n === "number" ? n : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: ccy, maximumFractionDigits: 2,
    }).format(v);
  } catch { return v.toFixed(2); }
}

// ---------------------------------------------------------------------------
// Data hooks

function useQueue() {
  const scope = useFinanceScope();
  return useQuery({
    queryKey: ["pos-posting-queue", scope.orgId, scope.businessId, scope.branchId],
    enabled: scope.isReady,
    queryFn: async (): Promise<QueueRow[]> => {
      // 1. Load pending statements
      let stmtQ = supabase
        .from("pos_statements")
        .select(`
          id, statement_number, shift_id, business_id, branch_id,
          organization_id, posting_status, close_kind, closed_at,
          journal_entry_id, total_sales, total_returns, total_tax
        `)
        .eq("organization_id", scope.orgId)
        .eq("business_id", scope.businessId!)
        .eq("posting_status", "pending")
        .not("closed_at", "is", null)
        .neq("close_kind", "historical_backfill")
        .order("closed_at", { ascending: false })
        .limit(200);
      if (scope.branchId) stmtQ = stmtQ.eq("branch_id", scope.branchId);
      const { data: stmts, error } = await stmtQ;
      if (error) throw error;
      const rows = (stmts ?? []) as unknown as Array<Omit<
        QueueRow, "outbox_attempts" | "outbox_last_error" | "outbox_updated_at"
        | "dead_at" | "dead_reason" | "retry_count" | "last_retry_at"
      >>;
      if (rows.length === 0) return [];

      // 2. Enrich with outbox status (live + dead)
      const ids = rows.map((r) => r.id);
      const [{ data: outboxLive }, { data: outboxDead }, { data: retries }] =
        await Promise.all([
          supabase
            .from("business_event_outbox")
            .select("source_doc_id, attempts, last_error, updated_at")
            .eq("source_doc_type", "pos_statement")
            .in("source_doc_id", ids),
          supabase
            .from("business_event_outbox_dead")
            .select("source_doc_id, dead_at, dead_reason, last_error")
            .eq("source_doc_type", "pos_statement")
            .in("source_doc_id", ids),
          supabase
            .from("pos_statement_posting_retries")
            .select("statement_id, requested_at")
            .in("statement_id", ids),
        ]);

      const liveByStmt = new Map<string, { attempts: number; last_error: string | null; updated_at: string | null }>();
      for (const r of (outboxLive ?? []) as Array<Record<string, unknown>>) {
        const key = r.source_doc_id as string;
        const cur = liveByStmt.get(key);
        const attempts = Number(r.attempts ?? 0);
        if (!cur || attempts > cur.attempts) {
          liveByStmt.set(key, {
            attempts,
            last_error: (r.last_error as string | null) ?? cur?.last_error ?? null,
            updated_at: (r.updated_at as string | null) ?? cur?.updated_at ?? null,
          });
        }
      }
      const deadByStmt = new Map<string, { dead_at: string; dead_reason: string | null; last_error: string | null }>();
      for (const r of (outboxDead ?? []) as Array<Record<string, unknown>>) {
        deadByStmt.set(r.source_doc_id as string, {
          dead_at: r.dead_at as string,
          dead_reason: (r.dead_reason as string | null) ?? null,
          last_error: (r.last_error as string | null) ?? null,
        });
      }
      const retryStats = new Map<string, { count: number; last: string | null }>();
      for (const r of (retries ?? []) as Array<Record<string, unknown>>) {
        const key = r.statement_id as string;
        const cur = retryStats.get(key) ?? { count: 0, last: null };
        cur.count += 1;
        const ts = r.requested_at as string;
        if (!cur.last || ts > cur.last) cur.last = ts;
        retryStats.set(key, cur);
      }

      return rows.map((r) => {
        const live = liveByStmt.get(r.id);
        const dead = deadByStmt.get(r.id);
        const rs = retryStats.get(r.id);
        return {
          ...r,
          outbox_attempts: live?.attempts ?? 0,
          outbox_last_error: live?.last_error ?? dead?.last_error ?? null,
          outbox_updated_at: live?.updated_at ?? null,
          dead_at: dead?.dead_at ?? null,
          dead_reason: dead?.dead_reason ?? null,
          retry_count: rs?.count ?? 0,
          last_retry_at: rs?.last ?? null,
        } as QueueRow;
      });
    },
  });
}

function usePreview(statementId: string | null) {
  return useQuery({
    queryKey: ["pos-statement-posting-preview", statementId],
    enabled: !!statementId,
    queryFn: async (): Promise<PreviewData | null> => {
      const { data, error } = await supabase.rpc(
        "get_pos_statement_posting_preview" as never,
        { p_statement_id: statementId } as never,
      );
      if (error) throw error;
      return (data ?? null) as unknown as PreviewData | null;
    },
  });
}

// ---------------------------------------------------------------------------
// Page

export default function PosPostingQueue() {
  const scope = useFinanceScope();
  const { baseCurrency } = useCurrency();
  const { data: rows = [], isLoading, error, refetch, isFetching } = useQueue();
  const [params, setParams] = useSearchParams();
  const initialShift = params.get("shift");
  const [selectedStatementId, setSelectedStatementId] = useState<string | null>(null);

  // If a ?shift=... deep-link came in, resolve it to a statement id on first render.
  useMemo(() => {
    if (!initialShift || selectedStatementId) return;
    const match = rows.find((r) => r.shift_id === initialShift);
    if (match) setSelectedStatementId(match.id);
  }, [initialShift, rows, selectedStatementId]);

  const kpis = useMemo(() => {
    const total = rows.length;
    const withErrors = rows.filter((r) => (r.outbox_attempts ?? 0) > 0 || !!r.dead_at).length;
    const dead = rows.filter((r) => !!r.dead_at).length;
    const notPosted = rows.filter((r) => !r.journal_entry_id).length;
    return { total, withErrors, dead, notPosted };
  }, [rows]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        title="POS Posting Queue"
        description="Every closed POS statement waiting to post to the general ledger, together with dispatcher errors and canonical account-mapping issues. This is the single place accountants act on POS posting problems — the POS Shift GL Integrity report is read-only."
      />

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">{scope.scopeLabel}</div>
        <Button
          variant="outline" size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Queued" value={String(kpis.total)} icon={<Clock className="h-4 w-4" />} />
        <Kpi
          label="With dispatcher errors" value={String(kpis.withErrors)}
          tone={kpis.withErrors > 0 ? "warn" : "ok"}
          icon={<AlertTriangle className="h-4 w-4" />}
        />
        <Kpi
          label="Dead-lettered" value={String(kpis.dead)}
          tone={kpis.dead > 0 ? "danger" : "ok"}
          icon={<ShieldAlert className="h-4 w-4" />}
        />
        <Kpi
          label="Not yet posted" value={String(kpis.notPosted)}
          tone={kpis.notPosted > 0 ? "warn" : "ok"}
          icon={<Send className="h-4 w-4" />}
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Failed to load queue</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Statement</TableHead>
                <TableHead>Closed</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead>Dispatcher</TableHead>
                <TableHead>Retries</TableHead>
                <TableHead className="w-[140px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7}>
                  <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                  </div>
                </TableCell></TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={7}>
                  <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground text-sm">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    Nothing pending — every closed POS statement has posted to the GL.
                  </div>
                </TableCell></TableRow>
              )}
              {rows.map((r) => {
                const hasError = (r.outbox_attempts ?? 0) > 0 || !!r.dead_at;
                return (
                  <TableRow key={r.id} className={hasError ? "bg-amber-50/40 dark:bg-amber-950/10" : ""}>
                    <TableCell className="font-mono text-xs">
                      {r.statement_number ?? r.id.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.closed_at ? format(new Date(r.closed_at), "yyyy-MM-dd HH:mm") : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtMoney(r.total_sales, baseCurrency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtMoney(r.total_tax, baseCurrency)}
                    </TableCell>
                    <TableCell>
                      {r.dead_at ? (
                        <Badge variant="destructive">Dead-lettered</Badge>
                      ) : (r.outbox_attempts ?? 0) > 0 ? (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" /> {r.outbox_attempts} attempts
                        </Badge>
                      ) : (
                        <Badge variant="outline">Waiting</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.retry_count > 0 ? (
                        <span title={r.last_retry_at ?? undefined}>
                          {r.retry_count} manual
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm" variant="secondary"
                        onClick={() => setSelectedStatementId(r.id)}
                      >
                        Review <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <StatementDrawer
        statementId={selectedStatementId}
        onClose={() => {
          setSelectedStatementId(null);
          if (params.get("shift")) {
            const next = new URLSearchParams(params);
            next.delete("shift");
            setParams(next, { replace: true });
          }
        }}
        currency={baseCurrency}
        queueRow={rows.find((r) => r.id === selectedStatementId) ?? null}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Statement drawer — preview + retry

function StatementDrawer({
  statementId, onClose, currency, queueRow,
}: {
  statementId: string | null;
  onClose: () => void;
  currency: string;
  queueRow: QueueRow | null;
}) {
  const qc = useQueryClient();
  const preview = usePreview(statementId);
  const [reason, setReason] = useState("");

  const retry = useMutation({
    mutationFn: async () => {
      if (!statementId) throw new Error("No statement selected");
      const { data, error } = await supabase.rpc(
        "retry_pos_statement_posting" as never,
        { p_statement_id: statementId, p_reason: reason.trim() || null } as never,
      );
      if (error) throw error;
      return data;
    },
    onSuccess: (data: unknown) => {
      const d = (data ?? {}) as Record<string, unknown>;
      if (d.already_posted) {
        toast.success("Already posted — nothing to retry");
      } else {
        toast.success("Retry queued — the dispatcher will re-run posting shortly");
      }
      setReason("");
      qc.invalidateQueries({ queryKey: ["pos-posting-queue"] });
      qc.invalidateQueries({ queryKey: ["pos-statement-posting-preview", statementId] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Retry failed: ${msg}`);
    },
  });

  const p = preview.data ?? null;

  return (
    <Dialog open={!!statementId} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Statement {p?.statement_number ?? statementId?.slice(0, 8) ?? ""}
          </DialogTitle>
        </DialogHeader>

        {preview.isLoading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Computing posting preview…
          </div>
        )}
        {preview.error && (
          <Alert variant="destructive">
            <AlertTitle>Preview failed</AlertTitle>
            <AlertDescription>{(preview.error as Error).message}</AlertDescription>
          </Alert>
        )}

        {p && (
          <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
            {queueRow?.outbox_last_error && (
              <Alert variant="destructive">
                <AlertTitle>Last dispatcher error</AlertTitle>
                <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
                  {queueRow.outbox_last_error}
                </AlertDescription>
              </Alert>
            )}

            {p.unresolved.length > 0 && (
              <Alert variant="destructive">
                <AlertTitle>{p.unresolved.length} unmapped account{p.unresolved.length === 1 ? "" : "s"}</AlertTitle>
                <AlertDescription>
                  <ul className="mt-2 space-y-1 text-xs">
                    {p.unresolved.map((u, i) => (
                      <li key={i}>
                        <span className="font-mono">{u.key}</span>
                        {" — "}{fmtMoney(u.amount, currency)}
                        <div className="text-muted-foreground">{u.hint}</div>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2">
                    <Button asChild size="sm" variant="outline">
                      <Link to="/finance/settings">Open Finance Settings → Default Accounts</Link>
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-3 text-xs">
              <SummaryLine label="Net revenue" amount={p.net_revenue} currency={currency}
                warn={!!p.revenue && !p.revenue.resolved} />
              <SummaryLine label="Tax" amount={p.tax?.amount ?? 0} currency={currency}
                warn={!!p.tax && !p.tax.resolved} />
              <SummaryLine label="Tip" amount={p.tip?.amount ?? 0} currency={currency} />
              <SummaryLine label="Total sales" amount={p.total_sales} currency={currency} />
            </div>

            <div>
              <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">Tenders</div>
              <div className="rounded border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Method</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                      <TableHead>Account</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.tenders.map((t, i) => (
                      <TableRow key={i} className={t.resolved ? "" : "bg-amber-50/40 dark:bg-amber-950/10"}>
                        <TableCell className="text-xs">{t.tender_method}{t.processor ? ` · ${t.processor}` : ""}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{t.tender_kind ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {fmtMoney(t.net_amount, currency)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {t.resolved ? (
                            <span title={t.account_id ?? ""}>{fmtAccount(t)}</span>
                          ) : (
                            <Badge variant="destructive" className="gap-1">
                              <AlertTriangle className="h-3 w-3" /> Unmapped
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {p.tenders.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-xs text-muted-foreground text-center py-3">
                          No tender lines on this statement.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs border-t pt-2">
              <span>Debit total: <span className="tabular-nums font-medium">{fmtMoney(p.total_debit, currency)}</span></span>
              <span>Credit total: <span className="tabular-nums font-medium">{fmtMoney(p.total_credit, currency)}</span></span>
              {p.balanced ? (
                <Badge variant="outline" className="ml-auto text-emerald-700 border-emerald-400">Balanced</Badge>
              ) : (
                <Badge variant="destructive" className="ml-auto">Out of balance</Badge>
              )}
            </div>

            <div className="space-y-2 border-t pt-3">
              <Label htmlFor="pos-retry-reason" className="text-xs">
                Reason for retry (audit log)
              </Label>
              <Textarea
                id="pos-retry-reason" rows={2}
                placeholder="e.g. Mapped Mpesa tender to Mpesa holding account"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={retry.isPending}
              />
              <div className="text-[11px] text-muted-foreground">
                Retry re-enqueues the posting event onto the outbox — the dispatcher runs
                the authoritative <code>post_pos_statement_gl</code> routine. Every retry
                is written to <code>pos_statement_posting_retries</code> with the reason,
                the actor, and an idempotency key.
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button
            onClick={() => retry.mutate()}
            disabled={
              retry.isPending
              || !p
              || p.posting_status === "posted"
              || p.unresolved.length > 0
            }
          >
            {retry.isPending ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Queuing…</>
            ) : (
              <><Send className="h-4 w-4 mr-1" /> Queue retry</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Small primitives

function Kpi({
  label, value, tone, icon,
}: { label: string; value: string; tone?: "ok" | "warn" | "danger"; icon?: React.ReactNode }) {
  const toneClass =
    tone === "danger" ? "text-destructive" :
    tone === "warn"   ? "text-amber-700" : "";
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}{label}
        </div>
        <div className={`text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function SummaryLine({
  label, amount, currency, warn,
}: { label: string; amount: number; currency: string; warn?: boolean }) {
  return (
    <div className={`flex justify-between rounded border px-3 py-2 ${warn ? "border-amber-400 bg-amber-50/40 dark:bg-amber-950/10" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">{fmtMoney(amount, currency)}</span>
    </div>
  );
}



