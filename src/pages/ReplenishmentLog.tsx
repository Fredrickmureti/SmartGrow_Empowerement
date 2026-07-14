/**
 * Inventory Planning Workspace — home of the procurement recommendations
 * engine. Planners triage here before Purchasing turns recommendations
 * into POs. The old auto-PO log stays on a secondary tab.
 */
import { useMemo, useState, useDeferredValue } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useReplenishmentLogs } from "@/hooks/useReplenishmentLogs";
import {
  useProcurementRecommendations,
  humanizeRecError,
  type ProcurementRecommendation,
  type RecUrgency,
  type RecStatus,
} from "@/hooks/useProcurementRecommendations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Toggle } from "@/components/ui/toggle";
import {
  RefreshCw,
  Search,
  Package,
  AlertTriangle,
  CheckCircle2,
  GitMerge,
  UserCircle2,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { normalizeError } from "@/services/resilience";
import { RecommendationDrawer } from "@/components/inventory/RecommendationDrawer";

const URGENCY_ORDER: Record<RecUrgency, number> = {
  stockout: 0,
  critical: 1,
  low: 2,
  planned: 3,
};

function urgencyBadge(u: RecUrgency) {
  switch (u) {
    case "stockout":
      return <Badge variant="destructive">Stock-out</Badge>;
    case "critical":
      return <Badge variant="destructive">Critical</Badge>;
    case "low":
      return <Badge className="bg-amber-500 hover:bg-amber-500 text-white">Low</Badge>;
    default:
      return <Badge variant="secondary">Planned</Badge>;
  }
}

function coverLabel(available: number, velocityPerWeek: number): string {
  if (velocityPerWeek <= 0) return "—";
  const dos = available / (velocityPerWeek / 7);
  return `${Math.round(dos)}d`;
}

/**
 * Explains why a candidate merge is not valid. Returns null when the
 * selection is mergeable client-side (same product + same preferred vendor).
 * The server re-validates business scope + status.
 */
function mergeBlockingReason(recs: ProcurementRecommendation[]): string | null {
  if (recs.length < 2) return "Select at least two recommendations to merge.";
  const first = recs[0];
  const sameProduct = recs.every((r) => r.product_id === first.product_id);
  if (!sameProduct) return "All selected rows must be the same product.";
  const sameVendor = recs.every(
    (r) => (r.preferred_vendor_id ?? null) === (first.preferred_vendor_id ?? null),
  );
  if (!sameVendor) return "All selected rows must share the same preferred vendor.";
  const mergeable: RecStatus[] = ["open", "in_review", "approved", "snoozed"];
  const badStatus = recs.find((r) => !mergeable.includes(r.status));
  if (badStatus) return `Cannot merge a recommendation with status "${badStatus.status}".`;
  return null;
}

export default function ReplenishmentLog() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { logs, isLoading: logsLoading } = useReplenishmentLogs();
  const {
    recommendations,
    runs,
    isLoading: recsLoading,
    runPlanning,
    mergeRecs,
  } = useProcurementRecommendations();

  // Per-tab state — do not share filters across tabs.
  const [recSearch, setRecSearch] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [logStatus, setLogStatus] = useState("all");
  const [urgencyFilter, setUrgencyFilter] = useState<"all" | RecUrgency>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | RecStatus>("all");
  const [vendorFilter, setVendorFilter] = useState<string>("all");
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [drawerRec, setDrawerRec] = useState<ProcurementRecommendation | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const deferredRecSearch = useDeferredValue(recSearch);

  const isTriggering = runPlanning.isPending;

  const handleRun = async () => {
    try {
      const r = await runPlanning.mutateAsync();
      toast.success(
        `Planning complete — ${r.recommendations_created} recommendation${
          r.recommendations_created === 1 ? "" : "s"
        } (stock-outs ${r.stockouts}, critical ${r.critical}, low ${r.low})`,
      );
    } catch (error) {
      toast.error(`Planning failed: ${humanizeRecError(normalizeError(error).message)}`);
    }
  };

  const kpis = useMemo(() => {
    const s = {
      stockout: 0,
      critical: 0,
      low: 0,
      planned: 0,
      incoming: 0,
      awaitingApproval: 0,
      assignedToMe: 0,
    };
    for (const r of recommendations) {
      s[r.urgency]++;
      s.incoming += Number(r.incoming || 0);
      if (r.status === "in_review") s.awaitingApproval++;
      if (user?.id && r.assignee_id === user.id) s.assignedToMe++;
    }
    return s;
  }, [recommendations, user?.id]);

  const filterOptions = useMemo(() => {
    const vendors = new Map<string, string>();
    const branches = new Map<string, string>();
    const sources = new Set<string>();
    for (const r of recommendations) {
      if (r.vendor?.id && r.vendor?.name) vendors.set(r.vendor.id, r.vendor.name);
      if (r.branch?.id && r.branch?.name) branches.set(r.branch.id, r.branch.name);
      if (r.suggested_source) sources.add(r.suggested_source);
    }
    return {
      vendors: Array.from(vendors, ([id, name]) => ({ id, name })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      branches: Array.from(branches, ([id, name]) => ({ id, name })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      sources: Array.from(sources),
    };
  }, [recommendations]);

  const filteredRecs = useMemo(() => {
    const q = deferredRecSearch.trim().toLowerCase();
    return recommendations
      .filter((r) => (urgencyFilter === "all" ? true : r.urgency === urgencyFilter))
      .filter((r) => (statusFilter === "all" ? true : r.status === statusFilter))
      .filter((r) => (vendorFilter === "all" ? true : r.vendor?.id === vendorFilter))
      .filter((r) => (warehouseFilter === "all" ? true : r.branch?.id === warehouseFilter))
      .filter((r) => (sourceFilter === "all" ? true : r.suggested_source === sourceFilter))
      .filter((r) => (assignedToMe ? r.assignee_id === user?.id : true))
      .filter((r) => {
        if (!q) return true;
        return (
          r.product?.name?.toLowerCase().includes(q) ||
          r.product?.sku?.toLowerCase().includes(q) ||
          r.vendor?.name?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
  }, [
    recommendations,
    urgencyFilter,
    statusFilter,
    vendorFilter,
    warehouseFilter,
    sourceFilter,
    assignedToMe,
    deferredRecSearch,
    user?.id,
  ]);

  // Prune selection to what is currently visible so bulk actions can't
  // touch rows the planner filtered away.
  const visibleIds = useMemo(() => new Set(filteredRecs.map((r) => r.id)), [filteredRecs]);
  const effectiveSelection = useMemo(() => {
    const out = new Set<string>();
    selected.forEach((id) => visibleIds.has(id) && out.add(id));
    return out;
  }, [selected, visibleIds]);
  const selectedRecs = useMemo(
    () => filteredRecs.filter((r) => effectiveSelection.has(r.id)),
    [filteredRecs, effectiveSelection],
  );
  const mergeError = useMemo(() => mergeBlockingReason(selectedRecs), [selectedRecs]);

  const filteredLogs = logs.filter((log) => {
    const q = logSearch.trim().toLowerCase();
    const matchesSearch =
      !q ||
      log.product?.name?.toLowerCase().includes(q) ||
      log.purchase_order?.po_number?.toLowerCase().includes(q);
    const matchesStatus = logStatus === "all" || log.status === logStatus;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "po_created":
        return (
          <Badge variant="default">
            <CheckCircle2 className="h-3 w-3 mr-1" /> PO Created
          </Badge>
        );
      case "pending":
        return <Badge variant="secondary">Pending</Badge>;
      case "failed":
        return (
          <Badge variant="destructive">
            <AlertTriangle className="h-3 w-3 mr-1" /> Failed
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const toggleSelected = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const openDrawer = (r: ProcurementRecommendation) => setDrawerRec(r);

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Inventory Planning</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Explainable procurement recommendations from live stock, open POs and 28-day velocity.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RefreshButton
              queryKeyPrefixes={[
                ["procurement-recommendations"] as const,
                ["replenishment-runs"] as const,
                ["replenishment-logs"] as const,
                ["low-stock-products"] as const,
              ]}
              tooltip="Refresh planning workspace"
            />
            <Button onClick={handleRun} disabled={isTriggering}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isTriggering ? "animate-spin" : ""}`} />
              {isTriggering ? "Planning..." : "Run planning"}
            </Button>
          </div>
        </div>

        <div className="stats-grid grid-cols-2 sm:grid-cols-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Stock-outs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{kpis.stockout}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Critical (&lt;7d)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{kpis.critical}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Low (&lt;14d)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-600">{kpis.low}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Awaiting approval</CardTitle>
            </CardHeader>
            <CardContent>
              <button
                type="button"
                className="text-2xl font-bold text-left hover:underline"
                onClick={() => setStatusFilter("in_review")}
                aria-label="Filter recommendations awaiting approval"
              >
                {kpis.awaitingApproval}
              </button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Assigned to me</CardTitle>
            </CardHeader>
            <CardContent>
              <button
                type="button"
                className="text-2xl font-bold text-left hover:underline"
                onClick={() => setAssignedToMe((v) => !v)}
                aria-pressed={assignedToMe}
                aria-label="Toggle assigned-to-me filter"
              >
                {kpis.assignedToMe}
              </button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Incoming units</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{Math.round(kpis.incoming)}</div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="recommendations" className="space-y-4">
          <TabsList>
            <TabsTrigger value="recommendations">Recommendations</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="log">Auto-PO log</TabsTrigger>
          </TabsList>

          <TabsContent value="recommendations" className="space-y-4">
            <div className="filter-bar">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search product, SKU or vendor…"
                  value={recSearch}
                  onChange={(e) => setRecSearch(e.target.value)}
                  className="pl-9 w-full"
                  aria-label="Search recommendations"
                />
              </div>
              <Select value={urgencyFilter} onValueChange={(v) => setUrgencyFilter(v as typeof urgencyFilter)}>
                <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filter by urgency">
                  <SelectValue placeholder="Filter by urgency" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All urgencies</SelectItem>
                  <SelectItem value="stockout">Stock-out</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="planned">Planned</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
                <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filter by status">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="in_review">Awaiting approval</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="snoozed">Snoozed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={vendorFilter} onValueChange={setVendorFilter}>
                <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filter by vendor">
                  <SelectValue placeholder="Filter by vendor" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All vendors</SelectItem>
                  {filterOptions.vendors.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filter by warehouse or branch">
                  <SelectValue placeholder="Filter by branch" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All branches</SelectItem>
                  {filterOptions.branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filter by source type">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  {filterOptions.sources.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s === "buy" ? "Buy" : s === "transfer" ? "Transfer" : "Manufacture"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Toggle
                pressed={assignedToMe}
                onPressedChange={setAssignedToMe}
                aria-label="Show only recommendations assigned to me"
                className="whitespace-nowrap"
              >
                <UserCircle2 className="h-4 w-4 mr-1" /> Mine
              </Toggle>
            </div>

            {recommendations.length >= 2000 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                Showing the first 2 000 open recommendations. Narrow the filters
                (urgency, vendor, branch) to see the rest, or split the run by branch.
              </div>
            )}

            {effectiveSelection.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <span className="font-medium">{effectiveSelection.size} selected</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!mergeError || mergeRecs.isPending}
                  title={mergeError ?? "Merge selected recommendations"}
                  onClick={async () => {
                    try {
                      await mergeRecs.mutateAsync(Array.from(effectiveSelection));
                      toast.success(`Merged ${effectiveSelection.size} recommendations`);
                      setSelected(new Set());
                    } catch (e) {
                      toast.error(`Merge failed: ${humanizeRecError(normalizeError(e).message)}`);
                    }
                  }}
                >
                  <GitMerge className="h-4 w-4 mr-1" /> Merge
                </Button>
                {mergeError && (
                  <span className="text-xs text-muted-foreground">{mergeError}</span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(new Set())}
                  className="ml-auto"
                >
                  Clear
                </Button>
              </div>
            )}

            <div className="table-container rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" aria-label="Select" />
                    <TableHead>Urgency</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="text-right">Reserved</TableHead>
                    <TableHead className="text-right">Incoming</TableHead>
                    <TableHead className="text-right">Cover</TableHead>
                    <TableHead className="text-right">Suggested</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Needed by</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recsLoading ? (
                    <TableRow>
                      <TableCell colSpan={12} className="text-center py-8">
                        Loading…
                      </TableCell>
                    </TableRow>
                  ) : filteredRecs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} className="text-center py-10 text-muted-foreground">
                        <div className="flex flex-col items-center gap-2">
                          <Package className="h-8 w-8" />
                          <span>No open recommendations.</span>
                          <span className="text-xs">
                            Configure reorder rules with safety stock / lead time, then run planning.
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredRecs.map((r) => {
                      const available = Math.max(0, Number(r.on_hand) - Number(r.reserved));
                      const effective = Number(r.edited_qty ?? r.suggested_qty);
                      const isSelected = effectiveSelection.has(r.id);
                      const label = `${r.product?.name ?? "Recommendation"} — ${r.urgency}`;
                      return (
                        <TableRow
                          key={r.id}
                          role="button"
                          tabIndex={0}
                          aria-label={label}
                          aria-selected={isSelected}
                          data-state={isSelected ? "selected" : undefined}
                          className="cursor-pointer hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=selected]:bg-muted/60"
                          onClick={() => openDrawer(r)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openDrawer(r);
                            }
                          }}
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={isSelected}
                              aria-label={`Select ${label}`}
                              onCheckedChange={(v) => toggleSelected(r.id, !!v)}
                            />
                          </TableCell>
                          <TableCell>{urgencyBadge(r.urgency)}</TableCell>
                          <TableCell className="font-medium">
                            {r.product?.name || "—"}
                            {r.product?.sku && (
                              <span className="text-xs text-muted-foreground ml-1">
                                ({r.product.sku})
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {r.branch?.name ?? "—"}
                          </TableCell>
                          <TableCell className="text-right">{Number(r.on_hand)}</TableCell>
                          <TableCell className="text-right">{Number(r.reserved)}</TableCell>
                          <TableCell className="text-right">{Number(r.incoming)}</TableCell>
                          <TableCell className="text-right">
                            {coverLabel(available, Number(r.velocity_per_week))}
                          </TableCell>
                          <TableCell className="text-right font-semibold">
                            {effective}
                            {r.edited_qty != null && (
                              <span
                                className="ml-1 text-[10px] text-amber-600"
                                title="Overridden"
                                aria-label="Quantity overridden"
                              >
                                *
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">{r.vendor?.name ?? "—"}</TableCell>
                          <TableCell className="text-sm">
                            {r.needed_by ? format(new Date(r.needed_by), "MMM d") : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {r.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>


          <TabsContent value="runs" className="space-y-4">
            <div className="table-container rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" aria-label="Expand" />
                    <TableHead>Started</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead className="text-right">Recs</TableHead>
                    <TableHead className="text-right">Stock-outs</TableHead>
                    <TableHead className="text-right">Critical</TableHead>
                    <TableHead className="text-right">Low</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                        No planning runs yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    runs.map((run) => {
                      const isExpanded = expandedRunId === run.id;
                      const durationMs =
                        run.completed_at && run.started_at
                          ? new Date(run.completed_at).getTime() -
                            new Date(run.started_at).getTime()
                          : null;
                      const duration =
                        durationMs === null
                          ? "—"
                          : durationMs < 1000
                            ? `${durationMs} ms`
                            : `${(durationMs / 1000).toFixed(1)} s`;
                      return (
                        <>
                          <TableRow
                            key={run.id}
                            role="button"
                            tabIndex={0}
                            aria-expanded={isExpanded}
                            aria-label={`Planning run started ${format(new Date(run.started_at), "PPpp")}`}
                            className="cursor-pointer hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setExpandedRunId(isExpanded ? null : run.id);
                              }
                            }}
                          >
                            <TableCell className="text-muted-foreground">
                              {isExpanded ? "▾" : "▸"}
                            </TableCell>
                            <TableCell className="text-sm">
                              {format(new Date(run.started_at), "MMM d, yyyy HH:mm")}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{run.run_type}</Badge>
                            </TableCell>
                            <TableCell>
                              {run.status === "failed" ? (
                                <Badge variant="destructive">Failed</Badge>
                              ) : run.status === "completed" ? (
                                <Badge variant="default">Completed</Badge>
                              ) : (
                                <Badge variant="secondary">
                                  <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                                  Running
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {duration}
                            </TableCell>
                            <TableCell className="text-right">{run.recommendations_created}</TableCell>
                            <TableCell className="text-right">{run.stockouts}</TableCell>
                            <TableCell className="text-right">{run.critical}</TableCell>
                            <TableCell className="text-right">{run.low}</TableCell>
                          </TableRow>
                          {isExpanded && (
                            <TableRow key={`${run.id}-detail`}>
                              <TableCell colSpan={9} className="bg-muted/30">
                                <div className="space-y-2 py-2 px-1 text-sm">
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                    <div>
                                      <div className="text-xs text-muted-foreground">
                                        Started
                                      </div>
                                      <div>
                                        {format(new Date(run.started_at), "PPpp")}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-xs text-muted-foreground">
                                        Completed
                                      </div>
                                      <div>
                                        {run.completed_at
                                          ? format(new Date(run.completed_at), "PPpp")
                                          : "—"}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-xs text-muted-foreground">
                                        Duration
                                      </div>
                                      <div>{duration}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs text-muted-foreground">
                                        Run ID
                                      </div>
                                      <div className="font-mono text-xs">
                                        {run.id.slice(0, 8)}…
                                      </div>
                                    </div>
                                  </div>
                                  {run.error_message && (
                                    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                                      <div className="font-semibold mb-1">
                                        Error
                                      </div>
                                      <pre className="whitespace-pre-wrap font-mono">
                                        {run.error_message}
                                      </pre>
                                    </div>
                                  )}
                                  {run.status === "running" && (
                                    <p className="text-xs text-muted-foreground">
                                      Planning still in progress — the workspace
                                      updates automatically via realtime.
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="log" className="space-y-4">
            <div className="filter-bar">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by product or PO number…"
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                  className="pl-9 w-full"
                  aria-label="Search auto-PO log"
                />
              </div>
              <Select value={logStatus} onValueChange={setLogStatus}>
                <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filter by log status">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="po_created">PO Created</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="table-container rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Triggered</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Stock Level</TableHead>
                    <TableHead className="text-right">Qty Ordered</TableHead>
                    <TableHead>PO #</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logsLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8">
                        Loading...
                      </TableCell>
                    </TableRow>
                  ) : filteredLogs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        <div className="flex flex-col items-center gap-2">
                          <Package className="h-8 w-8" />
                          <span>No auto-PO activity yet.</span>
                          <span className="text-xs">
                            Legacy: rows appear here only for reorder rules with "Auto Create PO" enabled.
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredLogs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className="text-sm">
                          {format(new Date(log.triggered_at), "MMM d, yyyy HH:mm")}
                        </TableCell>
                        <TableCell className="font-medium">
                          <button
                            className="text-primary hover:underline text-left"
                            onClick={() => navigate(`/inventory-app/products?selected=${log.product_id}`)}
                          >
                            {log.product?.name || "—"}
                          </button>
                          {log.product?.sku && (
                            <span className="text-xs text-muted-foreground ml-1">({log.product.sku})</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={log.trigger_type === "auto" ? "secondary" : "outline"}>
                            {log.trigger_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{log.current_stock}</TableCell>
                        <TableCell className="text-right">{log.reorder_quantity}</TableCell>
                        <TableCell>
                          {log.purchase_order ? (
                            <button
                              className="text-sm font-medium text-primary hover:underline"
                              onClick={() => navigate(`/purchases?selected=${log.purchase_order_id}`)}
                            >
                              {log.purchase_order.po_number}
                            </button>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {getStatusBadge(log.status)}
                            {log.error_message && (
                              <span className="text-xs text-destructive">{log.error_message}</span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <RecommendationDrawer
        rec={drawerRec}
        open={!!drawerRec}
        onClose={() => setDrawerRec(null)}
      />
    </>
  );
}
