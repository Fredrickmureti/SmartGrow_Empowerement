/**
 * Inventory Planning Workspace — renamed home of the former
 * "Replenishment log" page. The engine emits explainable procurement
 * recommendations (see `useProcurementRecommendations`) and this
 * workspace is where planners triage them before Purchasing turns
 * them into POs. The old auto-PO log stays on a secondary tab.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useReplenishmentLogs } from "@/hooks/useReplenishmentLogs";
import {
  useProcurementRecommendations,
  type ProcurementRecommendation,
  type RecUrgency,
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
import {
  RefreshCw,
  Search,
  Package,
  AlertTriangle,
  CheckCircle2,
  GitMerge,
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

export default function ReplenishmentLog() {
  const navigate = useNavigate();
  const { logs, isLoading: logsLoading } = useReplenishmentLogs();
  const {
    recommendations,
    runs,
    isLoading: recsLoading,
    runPlanning,
    mergeRecs,
  } = useProcurementRecommendations();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [urgencyFilter, setUrgencyFilter] = useState<"all" | RecUrgency>("all");
  const [drawerRec, setDrawerRec] = useState<ProcurementRecommendation | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const isTriggering = runPlanning.isPending;

  const handleRun = async () => {
    try {
      const r = await runPlanning.mutateAsync();
      toast.success(
        `Planning complete — ${r.recommendations_created} recommendation${r.recommendations_created === 1 ? "" : "s"} (stock-outs ${r.stockouts}, critical ${r.critical}, low ${r.low})`,
      );
    } catch (error: any) {
      toast.error(`Planning failed: ${normalizeError(error).message}`);
    }
  };

  const kpis = useMemo(() => {
    const s = { stockout: 0, critical: 0, low: 0, planned: 0, incoming: 0 };
    for (const r of recommendations) {
      s[r.urgency]++;
      s.incoming += Number(r.incoming || 0);
    }
    return s;
  }, [recommendations]);

  const filteredRecs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return recommendations
      .filter((r) => (urgencyFilter === "all" ? true : r.urgency === urgencyFilter))
      .filter((r) => {
        if (!q) return true;
        return (
          r.product?.name?.toLowerCase().includes(q) ||
          r.product?.sku?.toLowerCase().includes(q) ||
          r.vendor?.name?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
  }, [recommendations, urgencyFilter, searchQuery]);

  const filteredLogs = logs.filter((log) => {
    const matchesSearch =
      log.product?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.purchase_order?.po_number?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || log.status === statusFilter;
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

        <div className="stats-grid grid-cols-2 sm:grid-cols-5">
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
              <CardTitle className="text-sm font-medium text-muted-foreground">Planned</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{kpis.planned}</div>
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
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 w-full"
                />
              </div>
              <Select value={urgencyFilter} onValueChange={(v) => setUrgencyFilter(v as any)}>
                <SelectTrigger className="w-full sm:w-[200px]">
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
            </div>

            {selected.size > 0 && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <span className="font-medium">{selected.size} selected</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selected.size < 2 || mergeRecs.isPending}
                  onClick={async () => {
                    try {
                      await mergeRecs.mutateAsync(Array.from(selected));
                      toast.success(`Merged ${selected.size} recommendations`);
                      setSelected(new Set());
                    } catch (e) {
                      toast.error(`Merge failed: ${normalizeError(e).message}`);
                    }
                  }}
                >
                  <GitMerge className="h-4 w-4 mr-1" /> Merge (same product + vendor)
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            )}

            <div className="table-container rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
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
                      const effective = Number((r as any).edited_qty ?? r.suggested_qty);
                      return (
                        <TableRow
                          key={r.id}
                          className="cursor-pointer hover:bg-muted/40"
                          onClick={() => setDrawerRec(r)}
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={selected.has(r.id)}
                              onCheckedChange={(v) => {
                                setSelected((prev) => {
                                  const next = new Set(prev);
                                  if (v) next.add(r.id);
                                  else next.delete(r.id);
                                  return next;
                                });
                              }}
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
                            {(r as any).edited_qty != null && (
                              <span className="ml-1 text-[10px] text-amber-600" title="Overridden">*</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">{r.vendor?.name ?? "—"}</TableCell>
                          <TableCell className="text-sm">
                            {r.needed_by ? format(new Date(r.needed_by), "MMM d") : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {(r as any).status ?? "open"}
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
                    <TableHead>Started</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Recs</TableHead>
                    <TableHead className="text-right">Stock-outs</TableHead>
                    <TableHead className="text-right">Critical</TableHead>
                    <TableHead className="text-right">Low</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        No planning runs yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    runs.map((run) => (
                      <TableRow key={run.id}>
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
                            <Badge variant="secondary">Running</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{run.recommendations_created}</TableCell>
                        <TableCell className="text-right">{run.stockouts}</TableCell>
                        <TableCell className="text-right">{run.critical}</TableCell>
                        <TableCell className="text-right">{run.low}</TableCell>
                      </TableRow>
                    ))
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
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 w-full"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-[180px]">
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
        recommendation={drawerRec}
        open={!!drawerRec}
        onClose={() => setDrawerRec(null)}
      />
    </>
  );
}