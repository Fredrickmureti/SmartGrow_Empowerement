/**
 * Print Queue — Plan P3 Step 3.
 *
 * Read-only admin view over `public.print_jobs` for the current business.
 * Every user-triggered print now writes a ledger row through
 * `PrintClient.insertLedgerRow` (P2 Step 1) with a per-click idempotency
 * key (P3 Step 1) and, for multi-copy jobs, a `parent_job_id` link
 * (P3 Step 2). This page surfaces that ledger so operators can see:
 *
 *   - What was queued (doc type, intent, format, transport)
 *   - Where it is in the lifecycle (`queued` → `sent` → `acked` | `failed`)
 *   - Fan-out relationships (parent + children when copies > 1)
 *   - Why it failed (`last_error`)
 *
 * Zero write operations from this page — retries, ack backfills, and
 * cancels stay in the RPC/agent layer. RLS on `print_jobs` scopes rows
 * to the caller's businesses via `user_business_access`, so no server
 * filter is needed beyond current-business narrowing.
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

type JobStatus = "queued" | "sent" | "acked" | "failed" | string;

interface PrintJobRow {
  id: string;
  business_id: string;
  branch_id: string | null;
  doc_type: string;
  doc_id: string | null;
  intent: string;
  format: string;
  transport: string | null;
  status: JobStatus;
  correlation_id: string | null;
  parent_job_id: string | null;
  attempt_count: number | null;
  last_error: string | null;
  requested_at: string;
  sent_at: string | null;
  acked_at: string | null;
  failed_at: string | null;
}

const STATUS_ORDER: JobStatus[] = ["queued", "sent", "acked", "failed"];

function statusVariant(status: JobStatus): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "queued": return "outline";
    case "sent": return "secondary";
    case "acked": return "default";
    case "failed": return "destructive";
    default: return "outline";
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { hour12: false });
}

function elapsedMs(from: string, to: string | null): string {
  if (!to) return "—";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export default function HardwarePrintQueue() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id ?? null;

  const [rows, setRows] = useState<PrintJobRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const load = useMemo(() => async () => {
    if (!businessId) { setRows([]); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("print_jobs")
        .select("id,business_id,branch_id,doc_type,doc_id,intent,format,transport,status,correlation_id,parent_job_id,attempt_count,last_error,requested_at,sent_at,acked_at,failed_at")
        .eq("business_id", businessId)
        .order("requested_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      setRows((data ?? []) as PrintJobRow[]);
    } catch (e) {
      toast.error(`Failed to load print queue: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { void load(); }, [load]);

  const docTypes = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => s.add(r.doc_type));
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (docTypeFilter !== "all" && r.doc_type !== docTypeFilter) return false;
      if (q) {
        const hay = [r.doc_id, r.correlation_id, r.last_error, r.intent, r.transport]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, statusFilter, docTypeFilter, search]);

  // Group children under parents for the tree view. Parents are rows whose
  // `parent_job_id` is null. Rows whose parent falls outside the filtered
  // page (rare — same-business RLS + 500-row window) still render as
  // top-level so nothing is hidden.
  const grouped = useMemo(() => {
    const byId = new Map(filtered.map((r) => [r.id, r]));
    const children = new Map<string, PrintJobRow[]>();
    const roots: PrintJobRow[] = [];
    for (const r of filtered) {
      if (r.parent_job_id && byId.has(r.parent_job_id)) {
        const list = children.get(r.parent_job_id) ?? [];
        list.push(r);
        children.set(r.parent_job_id, list);
      } else {
        roots.push(r);
      }
    }
    return { roots, children };
  }, [filtered]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { queued: 0, sent: 0, acked: 0, failed: 0 };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  if (!businessId) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Print Queue</CardTitle>
            <CardDescription>Select a business to view its print job ledger.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Printer className="h-6 w-6" />
            Print Queue
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every print request, from click to hardware ack. Read-only ledger over <code>print_jobs</code>.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {STATUS_ORDER.map((s) => (
          <Card key={s}>
            <CardContent className="p-4">
              <div className="text-xs uppercase text-muted-foreground">{s}</div>
              <div className="text-2xl font-semibold mt-1">{counts[s] ?? 0}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={docTypeFilter} onValueChange={setDocTypeFilter}>
              <SelectTrigger className="w-56"><SelectValue placeholder="Document type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All document types</SelectItem>
                {docTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search doc id, correlation id, error…"
              className="w-72"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              {filtered.length} of {rows.length} rows · latest 500
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading && rows.length === 0 ? (
            <div className="p-6 space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No print jobs match the current filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requested</TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead>Intent / Format</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Latency</TableHead>
                  <TableHead>Correlation / Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grouped.roots.flatMap((parent) => {
                  const kids = grouped.children.get(parent.id) ?? [];
                  return [parent, ...kids].map((r) => {
                    const isChild = r.id !== parent.id;
                    const terminalAt = r.acked_at ?? r.failed_at ?? r.sent_at;
                    return (
                      <TableRow key={r.id} className={isChild ? "bg-muted/20" : undefined}>
                        <TableCell className="text-xs whitespace-nowrap">
                          {isChild && <span className="text-muted-foreground mr-1">↳</span>}
                          {fmtTime(r.requested_at)}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium">{r.doc_type}</div>
                          <div className="text-muted-foreground truncate max-w-[220px]">{r.doc_id ?? "—"}</div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>{r.intent}</div>
                          <div className="text-muted-foreground">{r.format}</div>
                        </TableCell>
                        <TableCell className="text-xs">{r.transport ?? "—"}</TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                          {r.attempt_count && r.attempt_count > 1 ? (
                            <span className="ml-2 text-xs text-muted-foreground">×{r.attempt_count}</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {elapsedMs(r.requested_at, terminalAt)}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-mono text-[11px] text-muted-foreground truncate max-w-[280px]">
                            {r.correlation_id ?? "—"}
                          </div>
                          {r.last_error && (
                            <div className="text-destructive truncate max-w-[280px]" title={r.last_error}>
                              {r.last_error}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  });
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
