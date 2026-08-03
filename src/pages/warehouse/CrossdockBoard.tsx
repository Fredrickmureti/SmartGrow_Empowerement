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
import { Truck, Check, X, PackageCheck, Forklift, AlertTriangle, RefreshCw } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";
import {
  useCrossdockOpportunities,
  useCrossdockRules,
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
  const { warehouses } = useWarehouses();
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
  const { data: rules } = useCrossdockRules(currentBusiness?.id);
  const transition = useCrossdockTransition();
  const sweep = useCrossdockSweep();

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

  const act = (
    row: CrossdockOpportunity,
    action: Parameters<typeof transition.mutate>[0]["action"],
    reason?: string,
  ) => transition.mutate({ action, id: row.id, rowVersion: row.row_version, reason });

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
          <Button size="sm" onClick={() => act(r, "markLoaded")}>
            <Truck className="h-4 w-4 mr-1" /> Mark loaded
          </Button>
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 mb-4">
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
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
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
