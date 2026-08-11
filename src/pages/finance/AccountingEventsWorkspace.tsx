/**
 * Accounting Events Workspace (B4)
 * ================================
 *
 * Producer-agnostic operational surface for every accounting-worthy business
 * fact enqueued into `public.accounting_events`. Supersedes the POS-specific
 * "POS Posting Queue" workspace — POS statements now appear here as one
 * producer among many (`producer='pos'`, `producer_doc_type='pos_statement'`).
 *
 * Contract with the Posting Engine
 * --------------------------------
 *  - The list reads directly from `accounting_events` filtered by scope.
 *  - The "Post now" action calls `accounting_post_event(event_id)` — the
 *    single authoritative posting entry-point (B3). Outcome envelope:
 *    { status: 'posted' | 'noop' | 'needs_mapping' | 'invalid' | 'deferred', ... }
 *  - When the producer is POS we additionally surface dispatcher health
 *    (attempts / dead-lettered) and the mapping preview from
 *    `get_pos_statement_posting_preview`, so accountants keep the same
 *    diagnostic depth they had in the legacy queue.
 *
 * State model (mirrors accounting_events.state)
 *  ready | needs_mapping | posting | posted | failed | superseded | cancelled | noop
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock, Loader2, RefreshCw,
  Send, ShieldAlert, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PageHeader } from "@/components/layout/page";
import { supabase } from "@/integrations/supabase/client";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useCurrency } from "@/hooks/useCurrency";
import { AuditDetails } from "@/components/audit/auditFormat";

// ---------------------------------------------------------------------------
// Types

type EventState =
  | "draft" | "ready" | "needs_mapping" | "posting" | "posted"
  | "failed" | "superseded" | "cancelled" | "noop";

interface AccountingEventRow {
  id: string;
  org_id: string;
  business_id: string | null;
  branch_id: string | null;
  producer: string;
  producer_doc_type: string;
  producer_doc_id: string;
  event_kind: string;
  state: EventState;
  amount: number | null;
  currency_code: string | null;
  business_date: string | null;
  requested_at: string;
  posted_at: string | null;
  journal_entry_id: string | null;
  last_diagnostic: Record<string, unknown> | null;
  version: number;
}

interface DispatcherHealth {
  attempts: number;
  last_error: string | null;
  dead_at: string | null;
  dead_reason: string | null;
}

// ---------------------------------------------------------------------------
// Data hooks

const STATE_FILTERS: { value: string; label: string }[] = [
  { value: "open", label: "Open (needs action)" },
  { value: "ready", label: "Ready" },
  { value: "needs_mapping", label: "Needs mapping" },
  { value: "failed", label: "Failed" },
  { value: "posted", label: "Posted" },
  { value: "all", label: "All" },
];

function useAccountingEvents(filter: string) {
  const scope = useFinanceScope();
  return useQuery({
    queryKey: ["accounting-events", scope.orgId, scope.businessId, scope.branchId, filter],
    enabled: scope.isReady,
    queryFn: async (): Promise<AccountingEventRow[]> => {
      let q = supabase
        .from("accounting_events")
        .select(`
          id, org_id, business_id, branch_id, producer, producer_doc_type,
          producer_doc_id, event_kind, state, amount, currency_code,
          business_date, requested_at, posted_at, journal_entry_id,
          last_diagnostic, version
        `)
        .eq("org_id", scope.orgId)
        .order("requested_at", { ascending: false })
        .limit(300);

      if (scope.businessId) q = q.eq("business_id", scope.businessId);
      if (scope.branchId) q = q.eq("branch_id", scope.branchId);

      if (filter === "open") {
        q = q.in("state", ["ready", "needs_mapping", "failed", "posting"]);
      } else if (filter !== "all") {
        q = q.eq("state", filter);
      }

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as AccountingEventRow[];
    },
  });
}

/**
 * Enrich POS-producer events with outbox dispatcher health so accountants
 * can distinguish "haven't tried yet" from "dispatcher tried 12 times".
 */
function useDispatcherHealthForPos(events: AccountingEventRow[]) {
  const posDocIds = useMemo(
    () => events.filter((e) => e.producer === "pos" && e.producer_doc_type === "pos_statement")
      .map((e) => e.producer_doc_id),
    [events],
  );
  return useQuery({
    queryKey: ["accounting-events-dispatcher-health", posDocIds.sort().join(",")],
    enabled: posDocIds.length > 0,
    queryFn: async (): Promise<Map<string, DispatcherHealth>> => {
      const [{ data: live }, { data: dead }] = await Promise.all([
        supabase.from("business_event_outbox")
          .select("source_doc_id, attempts, last_error")
          .eq("source_doc_type", "pos_statement")
          .in("source_doc_id", posDocIds),
        supabase.from("business_event_outbox_dead")
          .select("source_doc_id, dead_at, dead_reason, last_error")
          .eq("source_doc_type", "pos_statement")
          .in("source_doc_id", posDocIds),
      ]);
      const out = new Map<string, DispatcherHealth>();
      for (const r of (live ?? []) as Array<Record<string, unknown>>) {
        const key = r.source_doc_id as string;
        const attempts = Number(r.attempts ?? 0);
        const cur = out.get(key);
        if (!cur || attempts > cur.attempts) {
          out.set(key, {
            attempts,
            last_error: (r.last_error as string | null) ?? cur?.last_error ?? null,
            dead_at: cur?.dead_at ?? null,
            dead_reason: cur?.dead_reason ?? null,
          });
        }
      }
      for (const r of (dead ?? []) as Array<Record<string, unknown>>) {
        const key = r.source_doc_id as string;
        const cur = out.get(key) ?? { attempts: 0, last_error: null, dead_at: null, dead_reason: null };
        cur.dead_at = r.dead_at as string;
        cur.dead_reason = (r.dead_reason as string | null) ?? null;
        cur.last_error = cur.last_error ?? (r.last_error as string | null) ?? null;
        out.set(key, cur);
      }
      return out;
    },
  });
}

// ---------------------------------------------------------------------------
// POS statement enrichment — replace bare uuids with human labels.

interface PosStatementSummary {
  statement_number: string;
  close_kind: string | null;
  closed_at: string | null;
  opened_at: string | null;
  register_name: string | null;
  shift_number: string | null;
  cashier_name: string | null;
  total_sales: number | null;
  total_transactions: number | null;
  counted_cash: number | null;
  expected_cash: number | null;
  cash_variance: number | null;
}

function usePosStatementSummaries(events: AccountingEventRow[]) {
  const posDocIds = useMemo(
    () => Array.from(new Set(
      events.filter((e) => e.producer === "pos" && e.producer_doc_type === "pos_statement")
        .map((e) => e.producer_doc_id),
    )),
    [events],
  );
  return useQuery({
    queryKey: ["accounting-events-pos-summaries", posDocIds.sort().join(",")],
    enabled: posDocIds.length > 0,
    queryFn: async (): Promise<Map<string, PosStatementSummary>> => {
      const { data, error } = (await (supabase as any)
        .from("pos_statements")
        .select(`
          id, statement_number, close_kind, opened_at, closed_at,
          total_sales, total_transactions, counted_cash, expected_cash, cash_variance,
          closed_by,
          register:pos_registers!pos_statements_register_id_fkey ( register_name ),
          shift:pos_shifts!pos_statements_shift_id_fkey ( shift_number )
        `)
        .in("id", posDocIds)) as { data: any[] | null; error: any };
      if (error) throw error;
      const closedByIds = Array.from(new Set(
        (data ?? []).map((r) => (r as Record<string, unknown>).closed_by as string | null).filter(Boolean) as string[],
      ));
      const nameMap = new Map<string, string>();
      if (closedByIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, full_name, email")
          .in("id", closedByIds);
        for (const p of (profs ?? []) as Array<Record<string, unknown>>) {
          nameMap.set(p.id as string, (p.full_name as string) || (p.email as string) || "");
        }
      }
      const out = new Map<string, PosStatementSummary>();
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        out.set(r.id as string, {
          statement_number: (r.statement_number as string) ?? "",
          close_kind: (r.close_kind as string) ?? null,
          opened_at: (r.opened_at as string) ?? null,
          closed_at: (r.closed_at as string) ?? null,
          register_name: ((r.register as { register_name?: string } | null)?.register_name) ?? null,
          shift_number: ((r.shift as { shift_number?: string } | null)?.shift_number) ?? null,
          cashier_name: nameMap.get(r.closed_by as string) ?? null,
          total_sales: (r.total_sales as number) ?? null,
          total_transactions: (r.total_transactions as number) ?? null,
          counted_cash: (r.counted_cash as number) ?? null,
          expected_cash: (r.expected_cash as number) ?? null,
          cash_variance: (r.cash_variance as number) ?? null,
        });
      }
      return out;
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers

function fmtMoney(n: number | null | undefined, ccy: string) {
  const v = typeof n === "number" ? n : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: ccy, maximumFractionDigits: 2,
    }).format(v);
  } catch { return v.toFixed(2); }
}

const EVENT_KIND_LABELS: Record<string, string> = {
  shift_close: "Shift close",
  drawer_close: "Drawer close",
  day_close: "Day close",
  sale: "Sale",
  refund: "Refund",
};

function humanizeEventKind(kind: string): string {
  if (EVENT_KIND_LABELS[kind]) return EVENT_KIND_LABELS[kind];
  return kind.replace(/[_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function producerLabel(producer: string, docType: string): string {
  if (producer === "pos" && docType === "pos_statement") return "POS · Shift close";
  const p = producer.toUpperCase();
  const d = docType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `${p} · ${d}`;
}

function stateBadge(state: EventState) {
  switch (state) {
    case "posted":
      return <Badge variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-400">Posted</Badge>;
    case "ready":
      return <Badge variant="outline">Ready</Badge>;
    case "posting":
      return <Badge variant="secondary" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Posting</Badge>;
    case "needs_mapping":
      return <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> Needs mapping</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "noop":
      return <Badge variant="outline" className="text-muted-foreground">No-op</Badge>;
    case "superseded":
      return <Badge variant="outline" className="text-muted-foreground">Superseded</Badge>;
    case "cancelled":
      return <Badge variant="outline" className="text-muted-foreground">Cancelled</Badge>;
    default:
      return <Badge variant="outline">{state}</Badge>;
  }
}

// ---------------------------------------------------------------------------
// Page

export default function AccountingEventsWorkspace() {
  const scope = useFinanceScope();
  const { baseCurrency } = useCurrency();
  const [params, setParams] = useSearchParams();
  const filter = params.get("state") ?? "open";
  const setFilter = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === "open") next.delete("state"); else next.set("state", v);
    setParams(next, { replace: true });
  };

  const { data: rows = [], isLoading, error, refetch, isFetching } = useAccountingEvents(filter);
  const { data: dispatcherHealth } = useDispatcherHealthForPos(rows);
  const { data: posSummaries } = usePosStatementSummaries(rows);
  const [selected, setSelected] = useState<AccountingEventRow | null>(null);

  const kpis = useMemo(() => {
    const needsMapping = rows.filter((r) => r.state === "needs_mapping").length;
    const failed = rows.filter((r) => r.state === "failed").length;
    const ready = rows.filter((r) => r.state === "ready").length;
    const posted = rows.filter((r) => r.state === "posted").length;
    return { needsMapping, failed, ready, posted };
  }, [rows]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        title="Accounting Events"
        description="Every accounting-worthy business fact — POS shift closes, and (soon) sales invoices, bills, and inventory moves — flows through this workspace. Each row represents one canonical event routed through the unified Posting Engine (accounting_post_event). The legacy POS Posting Queue redirects here."
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{scope.scopeLabel}</div>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-8 w-[220px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATE_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Needs mapping" value={String(kpis.needsMapping)}
             tone={kpis.needsMapping > 0 ? "danger" : "ok"}
             icon={<ShieldAlert className="h-4 w-4" />} />
        <Kpi label="Failed" value={String(kpis.failed)}
             tone={kpis.failed > 0 ? "warn" : "ok"}
             icon={<AlertTriangle className="h-4 w-4" />} />
        <Kpi label="Ready to post" value={String(kpis.ready)}
             icon={<Clock className="h-4 w-4" />} />
        <Kpi label="Posted (window)" value={String(kpis.posted)}
             tone="ok" icon={<CheckCircle2 className="h-4 w-4" />} />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Failed to load accounting events</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Producer / Event</TableHead>
                <TableHead>Business date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Dispatcher</TableHead>
                <TableHead>Journal</TableHead>
                <TableHead className="w-[120px]" />
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
                    <Sparkles className="h-4 w-4 text-emerald-600" />
                    Nothing in this state — the sub-ledger is quiet.
                  </div>
                </TableCell></TableRow>
              )}
              {rows.map((r) => {
                const health = r.producer === "pos"
                  ? dispatcherHealth?.get(r.producer_doc_id)
                  : undefined;
                const summary = r.producer === "pos"
                  ? posSummaries?.get(r.producer_doc_id)
                  : undefined;
                const primaryLabel = summary?.statement_number
                  || `#${r.producer_doc_id.slice(0, 8)}`;
                const secondaryBits = [
                  humanizeEventKind(r.event_kind),
                  summary?.register_name,
                  summary?.cashier_name,
                ].filter(Boolean) as string[];
                return (
                  <TableRow key={r.id} className={r.state === "needs_mapping" || r.state === "failed" ? "bg-amber-50/40 dark:bg-amber-950/10" : ""}>
                    <TableCell className="text-xs">
                      <div className="font-medium">{producerLabel(r.producer, r.producer_doc_type)}</div>
                      <div className="text-xs text-foreground">{primaryLabel}</div>
                      {secondaryBits.length > 0 && (
                        <div className="text-[11px] text-muted-foreground">
                          {secondaryBits.join(" · ")}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.business_date
                        ? format(new Date(r.business_date), "yyyy-MM-dd")
                        : format(new Date(r.requested_at), "yyyy-MM-dd HH:mm")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtMoney(r.amount, r.currency_code ?? baseCurrency)}
                    </TableCell>
                    <TableCell>{stateBadge(r.state)}</TableCell>
                    <TableCell className="text-xs">
                      {health?.dead_at ? (
                        <Badge variant="destructive">Dead-lettered</Badge>
                      ) : (health?.attempts ?? 0) > 0 ? (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" /> {health!.attempts} attempts
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.journal_entry_id
                        ? <Badge variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-400">Journal posted</Badge>
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="secondary" onClick={() => setSelected(r)}>
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

      <EventDrawer
        event={selected}
        summary={selected && selected.producer === "pos" ? posSummaries?.get(selected.producer_doc_id) : undefined}
        onClose={() => setSelected(null)}
        currency={baseCurrency}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI + Drawer

function Kpi({
  label, value, icon, tone = "neutral",
}: { label: string; value: string; icon: React.ReactNode; tone?: "ok" | "warn" | "danger" | "neutral" }) {
  const toneClass =
    tone === "danger" ? "border-destructive/40 bg-destructive/5"
    : tone === "warn" ? "border-amber-400/40 bg-amber-50/50 dark:bg-amber-950/10"
    : tone === "ok" ? "border-emerald-400/40 bg-emerald-50/40 dark:bg-emerald-950/10"
    : "";
  return (
    <Card className={toneClass}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-muted-foreground">{icon}</div>
        </div>
        <div className="text-xl font-semibold tabular-nums mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

function EventDrawer({
  event, summary, onClose, currency,
}: {
  event: AccountingEventRow | null;
  summary?: PosStatementSummary;
  onClose: () => void;
  currency: string;
}) {
  const qc = useQueryClient();

  const postNow = useMutation({
    mutationFn: async () => {
      if (!event) throw new Error("No event selected");
      const { data, error } = await supabase.rpc(
        "accounting_post_event",
        { p_event_id: event.id },
      );
      if (error) {
        const e = error as { message?: string; details?: string; hint?: string };
        throw new Error([e.message, e.details, e.hint].filter(Boolean).join(" — "));
      }
      return data as { status: string; journal_entry_id?: string; reason?: string } | null;
    },
    onSuccess: (data) => {
      const status = data?.status ?? "unknown";
      if (status === "posted") toast.success(`Posted — ${data?.journal_entry_id?.slice(0, 8)}…`);
      else if (status === "noop") toast.info("No-op (nothing to post).");
      else if (status === "needs_mapping") toast.warning("Needs mapping — assign missing GL accounts to proceed.");
      else if (status === "deferred") toast.info("Deferred — will re-run on next dispatcher tick.");
      else toast.error(`Posting engine returned: ${status}${data?.reason ? ` — ${data.reason}` : ""}`);
      qc.invalidateQueries({ queryKey: ["accounting-events"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!event) return null;

  const headline = summary?.statement_number
    || `${humanizeEventKind(event.event_kind)} #${event.producer_doc_id.slice(0, 8)}`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>{producerLabel(event.producer, event.producer_doc_type)}</span>
            <span className="text-muted-foreground">·</span>
            <span>{headline}</span>
            {stateBadge(event.state)}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* Business summary — what actually happened, in accountant terms. */}
          {summary && (
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                Shift close summary
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <Field label="Statement" value={summary.statement_number || "—"} />
                <Field label="Close kind" value={summary.close_kind ? humanizeEventKind(summary.close_kind) : "—"} />
                <Field label="Register" value={summary.register_name || "—"} />
                <Field label="Shift" value={summary.shift_number || "—"} />
                <Field label="Closed by" value={summary.cashier_name || "—"} />
                <Field
                  label="Closed at"
                  value={summary.closed_at ? format(new Date(summary.closed_at), "yyyy-MM-dd HH:mm") : "—"}
                />
                <Field
                  label="Sales"
                  value={`${fmtMoney(summary.total_sales, event.currency_code ?? currency)} · ${summary.total_transactions ?? 0} txns`}
                />
                <Field
                  label="Cash variance"
                  value={fmtMoney(summary.cash_variance, event.currency_code ?? currency)}
                />
              </div>
            </div>
          )}

          {/* Posting lifecycle */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Field label="Event kind" value={humanizeEventKind(event.event_kind)} />
            <Field label="Version" value={`v${event.version}`} />
            <Field label="Requested" value={format(new Date(event.requested_at), "yyyy-MM-dd HH:mm")} />
            <Field label="Posted" value={event.posted_at ? format(new Date(event.posted_at), "yyyy-MM-dd HH:mm") : "—"} />
            <Field label="Amount" value={fmtMoney(event.amount, event.currency_code ?? currency)} />
            <Field
              label="Journal entry"
              value={event.journal_entry_id ? "Posted to ledger" : "Not yet posted"}
            />
          </div>

          {event.last_diagnostic && Object.keys(event.last_diagnostic).length > 0 && (
            <Alert>
              <AlertTitle className="text-xs">Last diagnostic</AlertTitle>
              <AlertDescription className="mt-2 space-y-2">
                <AuditDetails details={event.last_diagnostic} max={12} />
                <Collapsible>
                  <CollapsibleTrigger className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
                    Show raw payload
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="mt-2 text-[10px] whitespace-pre-wrap font-mono max-h-40 overflow-auto rounded border bg-background/50 p-2">
                      {JSON.stringify(event.last_diagnostic, null, 2)}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              </AlertDescription>
            </Alert>
          )}

          <Collapsible>
            <CollapsibleTrigger className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
              Technical identifiers
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
              <Field label="Event ID" value={event.id} mono />
              <Field label="Producer document ID" value={event.producer_doc_id} mono />
              {event.journal_entry_id && (
                <Field label="Journal entry ID" value={event.journal_entry_id} mono />
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button
            onClick={() => postNow.mutate()}
            disabled={postNow.isPending || event.state === "posted" || event.state === "cancelled" || event.state === "superseded"}
          >
            {postNow.isPending
              ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Posting…</>
              : <><Send className="h-3 w-3 mr-1" /> Post now</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xs ${mono ? "font-mono break-all" : ""}`}>{value}</div>
    </div>
  );
}

