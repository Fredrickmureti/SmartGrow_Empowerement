/**
 * Print activity — the operator-facing workspace over `print_jobs`.
 *
 * ADR-0100: the primary table shows business identity only
 * (document number, requester name, printer name, status). Every
 * technical field (correlation id, transport, raw error, retry
 * timeline) is available in the row drawer. Raw enums are rendered
 * through `humanize.ts` — never as leaf text.
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, Printer, AlertTriangle, CheckCircle2, Clock, PrinterOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import {
  docTypeLabel,
  intentLabel,
  statusLabel,
  statusTone,
  transportLabel,
  durationLabel,
  shortDateTime,
  classifyError,
} from "./lib/humanize";
import {
  useDocumentDisplay,
  useRequesterDisplay,
  usePrinterDisplay,
} from "./hooks/useHardwareDisplay";
import { JobDetailDrawer, type PrintJobDrawerRow } from "./components/JobDetailDrawer";

type PrintJobRow = PrintJobDrawerRow;

type DatePreset = "today" | "24h" | "7d" | "all";

const PAGE_SIZES = [25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZES)[number];

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "sent", label: "Sent to printer" },
  { value: "acked", label: "Printed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

function datePresetSince(preset: DatePreset): string | null {
  const now = Date.now();
  switch (preset) {
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case "24h":
      return new Date(now - 24 * 3600 * 1000).toISOString();
    case "7d":
      return new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    default:
      return null;
  }
}

export default function HardwarePrintQueue() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id ?? null;

  const [rows, setRows] = useState<PrintJobRow[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [printerFilter, setPrinterFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(50);
  const [drawerRow, setDrawerRow] = useState<PrintJobRow | null>(null);
  const [engineerMode, setEngineerMode] = useState(false);
  const [kpi, setKpi] = useState<{ printed: number; failed: number; queued: number; sent: number }>({
    printed: 0,
    failed: 0,
    queued: 0,
    sent: 0,
  });

  // Reset page whenever filters change.
  useEffect(() => {
    setPage(0);
  }, [statusFilter, datePreset, printerFilter, search, pageSize, businessId]);

  const load = useMemo(
    () => async () => {
      if (!businessId) {
        setRows([]);
        setTotalCount(0);
        return;
      }
      setLoading(true);
      try {
        const since = datePresetSince(datePreset);
        let q = supabase
          .from("print_jobs")
          .select(
            "id,business_id,branch_id,doc_type,doc_id,intent,format,transport,status,correlation_id,parent_job_id,attempt_count,last_error,requested_at,sent_at,acked_at,failed_at,requested_by,printer_profile_id",
            { count: "exact" },
          )
          .eq("business_id", businessId)
          .order("requested_at", { ascending: false });
        if (statusFilter !== "all") q = q.eq("status", statusFilter);
        if (printerFilter !== "all") q = q.eq("printer_profile_id", printerFilter);
        if (since) q = q.gte("requested_at", since);
        if (search.trim()) {
          const term = `%${search.trim()}%`;
          q = q.or(`correlation_id.ilike.${term},last_error.ilike.${term}`);
        }
        const from = page * pageSize;
        const to = from + pageSize - 1;
        const { data, error, count } = await q.range(from, to);
        if (error) throw error;
        setRows((data ?? []) as PrintJobRow[]);
        setTotalCount(count ?? null);
      } catch (e) {
        toast.error(`Failed to load print activity: ${(e as Error).message}`);
      } finally {
        setLoading(false);
      }
    },
    [businessId, statusFilter, datePreset, printerFilter, search, page, pageSize],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // KPI strip — one lightweight aggregate per status for the selected window.
  useEffect(() => {
    if (!businessId) return;
    const since = datePresetSince(datePreset);
    const statuses: Array<"acked" | "failed" | "queued" | "sent"> = ["acked", "failed", "queued", "sent"];
    Promise.all(
      statuses.map(async (s) => {
        let q = supabase
          .from("print_jobs")
          .select("id", { count: "exact", head: true })
          .eq("business_id", businessId)
          .eq("status", s);
        if (since) q = q.gte("requested_at", since);
        const { count } = await q;
        return [s, count ?? 0] as const;
      }),
    ).then((pairs) => {
      const next = { printed: 0, failed: 0, queued: 0, sent: 0 };
      for (const [s, c] of pairs) {
        if (s === "acked") next.printed = c;
        else if (s === "failed") next.failed = c;
        else if (s === "queued") next.queued = c;
        else if (s === "sent") next.sent = c;
      }
      setKpi(next);
    });
  }, [businessId, datePreset, rows.length]);

  // Printer filter options — from device_assignments for the business.
  const [printerOptions, setPrinterOptions] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => {
    if (!businessId) return;
    supabase
      .from("device_assignments")
      .select("id, display_name")
      .order("display_name")
      .then(({ data }) => {
        setPrinterOptions(
          (data ?? []).map((d) => ({ id: d.id, label: d.display_name || "Unnamed printer" })),
        );
      });
  }, [businessId]);

  // Resolvers — batched over currently visible rows.
  const documentDisplay = useDocumentDisplay(
    rows.map((r) => ({ doc_type: r.doc_type, doc_id: r.doc_id })),
  );
  const requesterDisplay = useRequesterDisplay(rows.map((r) => r.requested_by));
  const printerDisplay = usePrinterDisplay(rows.map((r) => r.printer_profile_id));

  // Group children under parents for the fan-out pill.
  const { roots, childrenByParent } = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const kids = new Map<string, PrintJobRow[]>();
    const roots: PrintJobRow[] = [];
    for (const r of rows) {
      if (r.parent_job_id && byId.has(r.parent_job_id)) {
        const list = kids.get(r.parent_job_id) ?? [];
        list.push(r);
        kids.set(r.parent_job_id, list);
      } else {
        roots.push(r);
      }
    }
    return { roots, childrenByParent: kids };
  }, [rows]);

  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) =>
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!businessId) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Print activity</CardTitle>
            <CardDescription>Select a business to view its print activity.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const totalPages = totalCount != null ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Printer className="h-6 w-6" />
            Print activity
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every document sent to a printer — click a row to see the timeline, destination, and any errors.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs flex items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox"
              checked={engineerMode}
              onChange={(e) => setEngineerMode(e.target.checked)}
            />
            Support engineer view
          </label>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />} label="Printed" value={kpi.printed} />
        <Kpi icon={<AlertTriangle className="h-4 w-4 text-destructive" />} label="Failed" value={kpi.failed} tone={kpi.failed > 0 ? "destructive" : undefined} />
        <Kpi icon={<Clock className="h-4 w-4 text-amber-600" />} label="Queued" value={kpi.queued} />
        <Kpi icon={<PrinterOff className="h-4 w-4 text-muted-foreground" />} label="Sent, not yet acknowledged" value={kpi.sent} />
      </div>

      {/* Filter bar */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={datePreset} onValueChange={(v) => setDatePreset(v as DatePreset)}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="all">All time</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={printerFilter} onValueChange={setPrinterFilter}>
              <SelectTrigger className="w-56"><SelectValue placeholder="All printers" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All printers</SelectItem>
                {printerOptions.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={engineerMode ? "Search correlation id or error…" : "Search error text…"}
              className="w-64"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              {totalCount ?? 0} matching jobs
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
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No print activity for the selected filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">Time</TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead>Requested by</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[80px]">Duration</TableHead>
                  {engineerMode && <TableHead>Correlation</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {roots.flatMap((parent) => {
                  const kids = childrenByParent.get(parent.id) ?? [];
                  const expanded = expandedParents.has(parent.id);
                  const list = [parent, ...(expanded ? kids : [])];
                  return list.map((r) => {
                    const isChild = r.id !== parent.id;
                    const terminalAt = r.acked_at ?? r.failed_at ?? r.sent_at;
                    const doc = documentDisplay(r.doc_type, r.doc_id);
                    const req = requesterDisplay(r.requested_by);
                    const printer = printerDisplay(r.printer_profile_id);
                    const err = r.last_error ? classifyError(r.last_error) : null;
                    return (
                      <TableRow
                        key={r.id}
                        className={`${isChild ? "bg-muted/20" : ""} cursor-pointer hover:bg-muted/40`}
                        onClick={() => setDrawerRow(r)}
                      >
                        <TableCell className="text-xs whitespace-nowrap">
                          {isChild && <span className="text-muted-foreground mr-1">↳</span>}
                          {shortDateTime(r.requested_at)}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-sm">{doc.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {intentLabel(r.intent)}
                            {!isChild && kids.length > 0 && (
                              <button
                                type="button"
                                className="ml-2 underline text-primary"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleExpand(parent.id);
                                }}
                              >
                                {expanded ? "Hide" : `+${kids.length} ${kids.length === 1 ? "copy" : "copies"}`}
                              </button>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{req.label}</TableCell>
                        <TableCell className="text-sm">
                          <div>{printer.label}</div>
                          <div className="text-xs text-muted-foreground">{transportLabel(r.transport)}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                          {r.attempt_count && r.attempt_count > 1 && (
                            <span className="ml-2 text-xs text-muted-foreground">×{r.attempt_count}</span>
                          )}
                          {err && (
                            <div className="text-xs text-destructive mt-0.5" title={r.last_error ?? ""}>
                              {err.summary}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {durationLabel(r.requested_at, terminalAt)}
                        </TableCell>
                        {engineerMode && (
                          <TableCell className="text-xs font-mono text-muted-foreground truncate max-w-[220px]">
                            {r.correlation_id ?? "—"}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  });
                })}
              </TableBody>
            </Table>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between p-3 border-t text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>Rows per page</span>
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v) as PageSize)}>
                <SelectTrigger className="w-20 h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span>Page {page + 1} of {totalPages}</span>
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
              <Button size="sm" variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <JobDetailDrawer
        row={drawerRow}
        open={!!drawerRow}
        onOpenChange={(o) => !o && setDrawerRow(null)}
        documentLabel={drawerRow ? documentDisplay(drawerRow.doc_type, drawerRow.doc_id) : { label: "" }}
        requesterLabel={drawerRow ? requesterDisplay(drawerRow.requested_by) : { label: "" }}
        printerLabel={drawerRow ? printerDisplay(drawerRow.printer_profile_id) : { label: "" }}
      />
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "destructive";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className={`text-2xl font-semibold mt-1 ${tone === "destructive" ? "text-destructive" : ""}`}>
          {value.toLocaleString()}
        </div>
      </CardContent>
    </Card>
  );
}
