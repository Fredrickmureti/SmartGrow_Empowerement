/**
 * Label Operations — the demand-and-run workspace for the Label
 * Operations Engine.
 *
 * Enterprise label printing is not "a button on a product row". It is a
 * queue: something happens in the business (goods received, price
 * changed, barcode enrolled) which *creates demand* for physical labels,
 * and an operator turns that demand into a run that a printer drains.
 *
 * This page is the operator's view of both halves:
 *   • Demand   — what the business says needs relabelling, and why.
 *   • Runs     — server-owned batches, with live progress, pause/resume,
 *                and per-line failure/refusal reasons.
 *
 * No printing happens in this component. It submits selections; the
 * engine expands and prints them.
 */
import { useMemo, useState } from "react";
import {
  Play, Pause, RotateCcw, X, Loader2, Tags, Printer, AlertTriangle, Ban, Trash2, Package,
} from "lucide-react";
import { format } from "date-fns";
import { useBusinesses } from "@/hooks/useBusinesses";
import { LabelRunHealthStrip } from "@/components/labels/LabelRunHealthStrip";
import { LabelProductPicker } from "@/components/labels/LabelProductPicker";

import {
  useLabelRuns, useLabelRunLines, useLabelDemand, useLabelRunActions,
  type LabelDemandReason, type LabelRun, type LabelRunStatus,
} from "@/hooks/inventory/useLabelRuns";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";

const REASON_COPY: Record<LabelDemandReason, { label: string; why: string }> = {
  goods_receipt: { label: "Goods received", why: "New stock arrived without shelf-ready labels" },
  price_change: { label: "Price changed", why: "Shelf edge no longer matches the till" },
  barcode_enrolled: { label: "Barcode enrolled", why: "Item became scannable and needs a printed code" },
  product_import: { label: "Newly imported", why: "Imported item has never been labelled" },
  promotion: { label: "Promotion", why: "Promotional pricing needs a new shelf edge" },
  recount: { label: "After count", why: "Label was missing or unreadable during a count" },
  manual: { label: "Manual request", why: "Requested by an operator" },
};

const TEMPLATE_OPTIONS = [
  { key: "product_label", workflow: "product_tag", label: "Product label" },
  { key: "shelf_label", workflow: "shelf_edge", label: "Shelf edge label" },
  { key: "lot_label", workflow: "product_tag", label: "Lot label" },
  { key: "bin_label", workflow: "receiving", label: "Bin / location label" },
] as const;

const STATUS_VARIANT: Record<LabelRunStatus, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  expanding: "secondary",
  running: "default",
  paused: "outline",
  completed: "secondary",
  failed: "destructive",
  cancelled: "outline",
};

export default function LabelOperations() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id ?? null;

  const { data: runs = [], isLoading: runsLoading } = useLabelRuns(businessId);
  const [reasonFilter, setReasonFilter] = useState<LabelDemandReason | "all">("all");
  const { data: demand = [], isLoading: demandLoading } = useLabelDemand(businessId, reasonFilter);
  const { createRun, setStatus, retryFailures, dismissDemand, purgeRuns } =
    useLabelRunActions(businessId);
  const [purgeAge, setPurgeAge] = useState<string>("30");

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [template, setTemplate] = useState<string>("shelf_label");
  const [copies, setCopies] = useState(1);
  const [openRun, setOpenRun] = useState<LabelRun | null>(null);

  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([k]) => k),
    [selected],
  );
  const tpl = TEMPLATE_OPTIONS.find((t) => t.key === template) ?? TEMPLATE_OPTIONS[1];

  const demandByReason = useMemo(() => {
    const m = new Map<LabelDemandReason, number>();
    for (const d of demand) m.set(d.reason, (m.get(d.reason) ?? 0) + 1);
    return m;
  }, [demand]);

  const submitSelected = () => {
    const ids = demand.filter((d) => selected[d.id]).map((d) => d.entity_id);
    if (!ids.length) return;
    createRun.mutate(
      {
        templateKey: tpl.key,
        workflow: tpl.workflow,
        entityType: "product",
        copies,
        name: `${tpl.label} — ${ids.length} item${ids.length === 1 ? "" : "s"}`,
        selection: { kind: "product_ids", ids },
      },
      { onSuccess: () => setSelected({}) },
    );
  };

  const submitAllDemand = () => {
    createRun.mutate({
      templateKey: tpl.key,
      workflow: tpl.workflow,
      entityType: "product",
      copies,
      name: `${tpl.label} — all open demand`,
      selection: { kind: "demand", reason: reasonFilter === "all" ? null : reasonFilter },
    });
  };

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Tags className="h-6 w-6 text-primary" />
            Label operations
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Labels are printed because physical stock has to carry the identity, price, or
            handling data the system holds. This is the queue of items whose paper no longer
            matches the record, and the runs draining it.
          </p>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open demand" value={demand.length} icon={<Tags className="h-4 w-4" />} />
        <StatCard
          label="Active runs"
          value={runs.filter((r) => r.status === "running" || r.status === "expanding").length}
          icon={<Printer className="h-4 w-4" />}
        />
        <StatCard
          label="Labels queued"
          value={runs.reduce((n, r) => n + (r.queued_lines ?? 0), 0)}
          icon={<Loader2 className="h-4 w-4" />}
        />
        <StatCard
          label="Needs attention"
          value={runs.reduce((n, r) => n + (r.failed_lines ?? 0) + (r.refused_lines ?? 0), 0)}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone="warning"
        />
      </div>

      <LabelRunHealthStrip businessId={businessId} />



      <Tabs defaultValue="demand">
        <TabsList>
          <TabsTrigger value="demand">Demand ({demand.length})</TabsTrigger>
          <TabsTrigger value="products">
            <Package className="mr-1.5 h-3.5 w-3.5" />
            Products
          </TabsTrigger>
          <TabsTrigger value="runs">Runs ({runs.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="mt-4">
          <LabelProductPicker businessId={businessId} />
        </TabsContent>


        <TabsContent value="demand" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Turn demand into a run</CardTitle>
              <CardDescription>
                The run is expanded and printed on the server — you can close this page once
                it is submitted.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Reason</Label>
                <Select
                  value={reasonFilter}
                  onValueChange={(v) => setReasonFilter(v as LabelDemandReason | "all")}
                >
                  <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All reasons</SelectItem>
                    {(Object.keys(REASON_COPY) as LabelDemandReason[]).map((r) => (
                      <SelectItem key={r} value={r}>
                        {REASON_COPY[r].label}
                        {demandByReason.get(r) ? ` (${demandByReason.get(r)})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Label</Label>
                <Select value={template} onValueChange={setTemplate}>
                  <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_OPTIONS.map((t) => (
                      <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Copies</Label>
                <Input
                  type="number"
                  min={1}
                  max={99}
                  value={copies}
                  onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 1))}
                  className="w-24"
                />
              </div>
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  disabled={!selectedIds.length || createRun.isPending}
                  onClick={submitSelected}
                >
                  Print selected ({selectedIds.length})
                </Button>
                <Button disabled={!demand.length || createRun.isPending} onClick={submitAllDemand}>
                  {createRun.isPending
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Printer className="mr-2 h-4 w-4" />}
                  Print all open demand
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={demand.length > 0 && selectedIds.length === demand.length}
                        onCheckedChange={(c) =>
                          setSelected(
                            c ? Object.fromEntries(demand.map((d) => [d.id, true])) : {},
                          )
                        }
                        aria-label="Select all demand"
                      />
                    </TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Why it needs a label</TableHead>
                    <TableHead className="text-right">Qty hint</TableHead>
                    <TableHead>Raised</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {demandLoading && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                      </TableCell>
                    </TableRow>
                  )}
                  {!demandLoading && demand.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                        Nothing needs relabelling. Demand appears here automatically when stock
                        is received, a price changes, or a barcode is enrolled.
                      </TableCell>
                    </TableRow>
                  )}
                  {demand.map((d) => {
                    const copy = REASON_COPY[d.reason] ?? REASON_COPY.manual;
                    const sku = d.detail?.["sku"] as string | undefined;
                    const name = (d.detail?.["name"] as string | undefined)
                      ?? sku
                      ?? `Unnamed ${d.entity_type}`;
                    return (
                      <TableRow key={d.id}>
                        <TableCell>
                          <Checkbox
                            checked={!!selected[d.id]}
                            onCheckedChange={(c) =>
                              setSelected((s) => ({ ...s, [d.id]: !!c }))
                            }
                            aria-label={`Select ${name}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <span>{name}</span>
                            {sku && name !== sku && (
                              <span className="text-xs font-normal text-muted-foreground">{sku}</span>
                            )}
                          </div>
                        </TableCell>

                        <TableCell>
                          <div className="flex flex-col">
                            <Badge variant="secondary" className="w-fit">{copy.label}</Badge>
                            <span className="mt-1 text-xs text-muted-foreground">{copy.why}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{d.qty_hint}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(d.created_at), "d MMM, HH:mm")}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Dismiss"
                            onClick={() => dismissDemand.mutate([d.id])}
                          >
                            <Ban className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3 pb-3">
              <div>
                <CardTitle className="text-base">Run history</CardTitle>
                <CardDescription>
                  Finished runs are kept as the audit record of what reached paper. Clear
                  them once you no longer need the trail — in-flight runs are never removed.
                </CardDescription>
              </div>
              <div className="flex items-end gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Clear finished runs</Label>
                  <Select value={purgeAge} onValueChange={setPurgeAge}>
                    <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7">Older than 7 days</SelectItem>
                      <SelectItem value="30">Older than 30 days</SelectItem>
                      <SelectItem value="90">Older than 90 days</SelectItem>
                      <SelectItem value="365">Older than 1 year</SelectItem>
                      <SelectItem value="0">All finished runs</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  variant="outline"
                  disabled={purgeRuns.isPending || !runs.length}
                  onClick={() => purgeRuns.mutate({ olderThanDays: Number(purgeAge) })}
                >
                  {purgeRuns.isPending
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Trash2 className="mr-2 h-4 w-4" />}
                  Clear
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-64">Progress</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runsLoading && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-10 text-center">
                        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                      </TableCell>
                    </TableRow>
                  )}
                  {!runsLoading && runs.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                        No label runs yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {runs.map((r) => {
                    const done = (r.printed_lines ?? 0) + (r.failed_lines ?? 0) + (r.refused_lines ?? 0);
                    const pct = r.total_lines ? Math.round((done / r.total_lines) * 100) : 0;
                    return (
                      <TableRow
                        key={r.id}
                        className="cursor-pointer"
                        onClick={() => setOpenRun(r)}
                      >
                        <TableCell>
                          <div className="font-medium">{r.name ?? r.template_key}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.template_key} · {r.copies} cop{r.copies === 1 ? "y" : "ies"} each
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{r.status}</Badge>
                        </TableCell>
                        <TableCell>
                          <Progress value={pct} className="h-2" />
                          <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                            {done} / {r.total_lines || "…"} printed
                            {r.failed_lines ? ` · ${r.failed_lines} failed` : ""}
                            {r.refused_lines ? ` · ${r.refused_lines} refused` : ""}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(r.created_at), "d MMM, HH:mm")}
                        </TableCell>
                        <TableCell
                          className="text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex justify-end gap-1">
                            {r.status === "running" || r.status === "expanding" ? (
                              <Button
                                size="icon" variant="ghost" aria-label="Pause run"
                                onClick={() => setStatus.mutate({ runId: r.id, status: "paused" })}
                              >
                                <Pause className="h-4 w-4" />
                              </Button>
                            ) : r.status === "paused" ? (
                              <Button
                                size="icon" variant="ghost" aria-label="Resume run"
                                onClick={() => setStatus.mutate({ runId: r.id, status: "running" })}
                              >
                                <Play className="h-4 w-4" />
                              </Button>
                            ) : null}
                            {(r.failed_lines ?? 0) > 0 && (
                              <Button
                                size="icon" variant="ghost" aria-label="Retry failures"
                                onClick={() => retryFailures.mutate(r.id)}
                              >
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            )}
                            {r.status !== "completed" && r.status !== "cancelled" && (
                              <Button
                                size="icon" variant="ghost" aria-label="Cancel run"
                                onClick={() => setStatus.mutate({ runId: r.id, status: "cancelled" })}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            )}
                            {(r.status === "completed" || r.status === "cancelled" || r.status === "failed") && (
                              <Button
                                size="icon" variant="ghost" aria-label="Delete run"
                                onClick={() => purgeRuns.mutate({ runIds: [r.id] })}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <RunDetailSheet run={openRun} onClose={() => setOpenRun(null)} />
    </div>
  );
}

function StatCard({
  label, value, icon, tone,
}: { label: string; value: number; icon: React.ReactNode; tone?: "warning" }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className={`text-2xl font-semibold tabular-nums ${tone === "warning" && value > 0 ? "text-destructive" : ""}`}>
            {value}
          </div>
        </div>
        <div className="text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  );
}

function RunDetailSheet({ run, onClose }: { run: LabelRun | null; onClose: () => void }) {
  const { data: lines = [], isLoading } = useLabelRunLines(run?.id ?? null, "all");
  return (
    <Sheet open={!!run} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{run?.name ?? run?.template_key ?? "Run"}</SheetTitle>
          <SheetDescription>
            Every line the engine expanded, and what happened to it. Refused lines never
            reached a printer — the item had no printable barcode identity.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 max-h-[75vh] overflow-y-auto">
          {isLoading ? (
            <Loader2 className="mx-auto mt-8 h-5 w-5 animate-spin" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">
                      {l.entity_label ?? l.entity_id.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          l.status === "printed" ? "secondary"
                            : l.status === "failed" ? "destructive"
                            : "outline"
                        }
                      >
                        {l.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {l.error ?? `${l.copies} cop${l.copies === 1 ? "y" : "ies"}`}
                    </TableCell>
                  </TableRow>
                ))}
                {lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                      Expansion has not produced lines yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
