/**
 * Cross-dock Decision Center.
 *
 * Cross-docking = inbound freight that never enters storage. This board is
 * where a supervisor triages qualified matches, approves them to a dock and
 * staging lane, watches execution (staging → staged → loaded → completed),
 * and breaks a plan back to put-away when the floor says no.
 *
 * All writes go through `useCrossdockTransition()` (aggregate wrapper) —
 * this page never calls a cross-dock RPC directly.
 */
import { useMemo, useState } from "react";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Truck, Check, X, PackageCheck, Forklift, AlertTriangle, RefreshCw, Printer } from "lucide-react";
import { toast } from "sonner";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useWarehouses } from "@/hooks/useWarehouses";
import { CrossdockRulesEditor } from "@/features/warehouse/crossdock/CrossdockRulesEditor";
import { printCrossdockRoutingLabel } from "@/features/warehouse/crossdock/crossdockLabels";
import {
  useCrossdockOpportunities,
  useCrossdockMetrics,
  useCrossdockSweep,
  useCrossdockTransition,
  type CrossdockOpportunity,
  type CrossdockState,
} from "@/features/warehouse/crossdock/useCrossdock";


const LANES: { key: string; label: string; states: CrossdockState[] }[] = [
  { key: "decide", label: "Awaiting decision", states: ["detected", "qualified"] },
  { key: "execute", label: "In execution", states: ["approved", "staging", "staged", "loaded"] },
  { key: "closed", label: "Closed", states: ["completed", "rejected", "expired", "broken", "cancelled"] },
];

const STATE_TONE: Record<CrossdockState, "default" | "secondary" | "outline" | "destructive"> = {
  detected: "outline",
  qualified: "default",
  approved: "default",
  staging: "secondary",
  staged: "secondary",
  loaded: "secondary",
  completed: "secondary",
  rejected: "destructive",
  expired: "destructive",
  broken: "destructive",
  cancelled: "outline",
};

function hoursLeft(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  return (new Date(expiresAt).getTime() - Date.now()) / 3_600_000;
}

export default function CrossdockBoard() {
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { warehouses } = useWarehouses();
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [lane, setLane] = useState<string>("decide");

  const activeLane = LANES.find((l) => l.key === lane) ?? LANES[0];

  const { data, isLoading } = useCrossdockOpportunities({
    businessId: currentBusiness?.id,
    warehouseId: warehouseFilter,
    states: activeLane.states,
  });
  const { data: allRows } = useCrossdockOpportunities({
    businessId: currentBusiness?.id,
    warehouseId: warehouseFilter,
  });
  const { data: metrics } = useCrossdockMetrics(currentBusiness?.id, warehouseFilter);
  const transition = useCrossdockTransition();
  const sweep = useCrossdockSweep();
  const [selected, setSelected] = useState<string[]>([]);

  const kpis = useMemo(() => {
    const rows = allRows ?? [];
    const count = (s: CrossdockState[]) => rows.filter((r) => s.includes(r.state)).length;
    const expiring = rows.filter((r) => {
      const h = hoursLeft(r.expires_at);
      return h !== null && h > 0 && h <= 4 && !["completed", "cancelled", "rejected", "expired", "broken"].includes(r.state);
    }).length;
    const touchesSaved = count(["completed"]);
    return {
      awaiting: count(["detected", "qualified"]),
      executing: count(["approved", "staging", "staged", "loaded"]),
      completed: touchesSaved,
      failed: count(["expired", "broken"]),
      expiring,
    };
  }, [allRows]);

  /** 30-day flow-through performance, straight off the metrics view. */
  const perf = useMemo(() => {
    const rows = metrics ?? [];
    const sum = (k: keyof (typeof rows)[number]) =>
      rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const opportunities = sum("opportunities");
    const completed = sum("completed");
    const dwell = rows.filter((r) => r.avg_dwell_hours !== null);
    return {
      successRate: opportunities ? (completed / opportunities) * 100 : null,
      unitsFlowed: sum("units_flowed"),
      touchesAvoided: sum("touches_avoided"),
      storageDaysAvoided: sum("storage_days_avoided"),
      savings: sum("savings_estimate"),
      avgDwell: dwell.length
        ? dwell.reduce((t, r) => t + Number(r.avg_dwell_hours), 0) / dwell.length
        : null,
    };
  }, [metrics]);


  const act = (
    row: CrossdockOpportunity,
    action: Parameters<typeof transition.mutate>[0]["action"],
    reason?: string,
  ) => transition.mutate({ action, id: row.id, rowVersion: row.row_version, reason });

  /**
   * A flow-through pallet must look different from a put-away pallet on
   * the floor. Rendering and device routing stay on the print platform.
   */
  const printRouting = async (row: CrossdockOpportunity) => {
    if (!currentOrg?.id) {
      toast.error("No active organization");
      return;
    }
    setPrintingId(row.id);
    try {
      const res = await printCrossdockRoutingLabel({
        orgId: currentOrg.id,
        row,
        businessId: currentBusiness?.id ?? null,
      });
      if (res.success) toast.success("Routing label sent to the printer");
      else toast.error(res.error ?? "Could not print the routing label");
    } finally {
      setPrintingId(null);
    }
  };

  const printButton = (r: CrossdockOpportunity) => (
    <Button
      size="sm"
      variant="ghost"
      disabled={printingId === r.id}
      onClick={() => printRouting(r)}
      title="Print cross-dock routing label"
    >
      <Printer className="h-4 w-4" />
    </Button>
  );


  const rowActions = (r: CrossdockOpportunity) => {
    switch (r.state) {
      case "detected":
      case "qualified":
        return (
          <>
            <Button size="sm" onClick={() => act(r, "approve")}>
              <Check className="h-4 w-4 mr-1" /> Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => act(r, "reject", "Rejected from board")}>
              <X className="h-4 w-4 mr-1" /> Reject
            </Button>
          </>
        );
      case "approved":
        return (
          <>
            {printButton(r)}
            <Button size="sm" onClick={() => act(r, "startStaging")}>
              <Forklift className="h-4 w-4 mr-1" /> Issue move
            </Button>
            <Button size="sm" variant="outline" onClick={() => act(r, "break", "Broken from board")}>
              Break
            </Button>
          </>
        );
      case "staging":
        return (
          <>
            {printButton(r)}
            <Button size="sm" onClick={() => act(r, "confirmStaged")}>
              <PackageCheck className="h-4 w-4 mr-1" /> Confirm staged
            </Button>
            <Button size="sm" variant="outline" onClick={() => act(r, "break", "Broken from board")}>
              Break
            </Button>
          </>
        );
      case "staged":
        return (
          <>
            {printButton(r)}
            <Button size="sm" onClick={() => act(r, "markLoaded")}>
              <Truck className="h-4 w-4 mr-1" /> Mark loaded
            </Button>
          </>
        );
      case "loaded":
        return (
          <Button size="sm" onClick={() => act(r, "complete")}>
            <Check className="h-4 w-4 mr-1" /> Complete
          </Button>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <PageHeader
        title="Cross-dock decision center"
        description="Inbound freight that can skip storage entirely — qualify, approve to a dock, direct the move, and ship straight out."
      />
      <PageBody>
        <div className="grid gap-3 @xl/page:grid-cols-2 @4xl/page:grid-cols-5 mb-4">
          {[
            { label: "Awaiting decision", value: kpis.awaiting },
            { label: "In execution", value: kpis.executing },
            { label: "Completed", value: kpis.completed },
            { label: "Expiring < 4h", value: kpis.expiring },
            { label: "Expired / broken", value: kpis.failed },
          ].map((k) => (
            <Card key={k.label}>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">{k.label}</p>
                <p className="text-2xl font-semibold">{k.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="mb-4">
          <CardContent className="grid gap-4 pt-6 @xl/page:grid-cols-3 @4xl/page:grid-cols-6">
            {[
              {
                label: "Flow-through rate (30d)",
                value: perf.successRate === null ? "—" : `${perf.successRate.toFixed(0)}%`,
              },
              { label: "Units flowed", value: perf.unitsFlowed.toLocaleString() },
              { label: "Touches avoided", value: perf.touchesAvoided.toLocaleString() },
              { label: "Storage days avoided", value: perf.storageDaysAvoided.toLocaleString() },
              {
                label: "Avg dwell",
                value: perf.avgDwell === null ? "—" : `${perf.avgDwell.toFixed(1)}h`,
              },
              { label: "Estimated saving", value: perf.savings.toLocaleString() },
            ].map((m) => (
              <div key={m.label}>
                <p className="text-xs text-muted-foreground">{m.label}</p>
                <p className="text-lg font-semibold">{m.value}</p>
              </div>
            ))}
          </CardContent>
        </Card>


        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div className="w-56">
            <Label>Warehouse</Label>
            <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All warehouses</SelectItem>
                {(warehouses ?? []).map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Tabs value={lane} onValueChange={setLane}>
            <TabsList>
              {LANES.map((l) => (
                <TabsTrigger key={l.key} value={l.key}>{l.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {lane === "decide" && selected.length > 0 && (
            <Button
              size="sm"
              className="ml-auto"
              disabled={transition.isPending}
              onClick={() => {
                (data ?? [])
                  .filter((r) => selected.includes(r.id))
                  .forEach((r) =>
                    transition.mutate({ action: "approve", id: r.id, rowVersion: r.row_version }),
                  );
                setSelected([]);
              }}
            >
              <Check className="h-4 w-4 mr-1" /> Approve {selected.length} selected
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className={lane === "decide" && selected.length > 0 ? "" : "ml-auto"}
            onClick={() => sweep.mutate()}
            disabled={sweep.isPending}
          >
            <RefreshCw className="h-4 w-4 mr-1" /> Sweep lapsed
          </Button>
        </div>

        {isLoading ? (
          <LoadingState />
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="Nothing in this lane"
            description="Cross-dock candidates are qualified automatically as receipts are captured, using the active cross-dock policy."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {lane === "decide" && <TableHead className="w-8" />}
                <TableHead>Score</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Demand</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Dock / lane</TableHead>
                <TableHead>Operator</TableHead>
                <TableHead>Cut-off</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => {
                const h = hoursLeft(r.expires_at);
                return (
                  <TableRow key={r.id}>
                    {lane === "decide" && (
                      <TableCell>
                        <Checkbox
                          checked={selected.includes(r.id)}
                          onCheckedChange={(v) =>
                            setSelected((s) =>
                              v ? [...s, r.id] : s.filter((id) => id !== r.id),
                            )
                          }
                          aria-label="Select plan"
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-semibold">{r.score ?? "—"}</TableCell>
                    <TableCell>
                      <span className="font-medium">{r.product_name ?? "Unnamed product"}</span>
                      {r.product_sku && (
                        <p className="text-xs text-muted-foreground">{r.product_sku}</p>
                      )}
                    </TableCell>
                    <TableCell>{Number(r.quantity)}</TableCell>
                    <TableCell className="text-xs">
                      <span className="capitalize">{r.demand_type.replace("_", " ")}</span>{" "}
                      <span className="font-medium">{r.demand_number ?? "—"}</span>
                    </TableCell>
                    <TableCell className="text-xs">{r.customer_name ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {r.dock_code ?? "—"}
                      {r.staging_code && (
                        <span className="text-muted-foreground"> · {r.staging_code}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{r.assignee_name ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {h === null ? "—" : h <= 0 ? (
                        <span className="text-destructive inline-flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> lapsed
                        </span>
                      ) : (
                        <span className={h <= 4 ? "text-destructive font-medium" : undefined}>
                          {h.toFixed(1)}h
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATE_TONE[r.state]}>{r.state}</Badge>
                      {(r.reject_reason || r.break_reason) && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {r.reject_reason ?? r.break_reason}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2 justify-end">{rowActions(r)}</div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <CrossdockRulesEditor businessId={currentBusiness?.id} />

      </PageBody>
    </>
  );
}
