/**
 * Replenishment — supervisor view (ADR 0106).
 *
 * Reads `wms_replenishment_rules` (per warehouse), runs the
 * `plan_replenishment(warehouse_id, mode)` engine to create
 * `wms_replen_orders` and dispatch `replenish` tasks, and shows the
 * resulting open queue. Rule writes go through the standard PostgREST
 * path (RLS-scoped). Order/task writes are RPC-only.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Waves, Plus, Play, Power } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useAuth } from "@/contexts/AuthContext";

interface RuleRow {
  id: string;
  warehouse_id: string;
  product_id: string;
  pick_location_id: string;
  source_location_id: string | null;
  min_qty: number;
  max_qty: number;
  pack_multiple: number;
  priority: number;
  is_active: boolean;
  last_run_at: string | null;
  product?: { name: string; sku: string | null } | null;
  pick_loc?: { code: string } | null;
  source_loc?: { code: string } | null;
}

interface TaskRow {
  id: string;
  state: string;
  priority: number;
  quantity: number | null;
  created_at: string;
  product?: { name: string; sku: string | null } | null;
  source_loc?: { code: string } | null;
  dest_loc?: { code: string } | null;
}

const STATE_TONE = {
  pending: "neutral",
  assigned: "info",
  in_progress: "warning",
  done: "success",
  cancelled: "danger",
} as const;

export default function Replenishment() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const { user } = useAuth();
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);

  const effectiveWarehouseId = useMemo(() => {
    if (warehouseFilter !== "all") return warehouseFilter;
    return warehouses?.[0]?.id ?? null;
  }, [warehouseFilter, warehouses]);

  const { data: rules, isLoading: rulesLoading } = useQuery({
    queryKey: ["wms-replen-rules", currentBusiness?.id, warehouseFilter],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_replenishment_rules")
        .select(
          "id,warehouse_id,product_id,pick_location_id,source_location_id,min_qty,max_qty,pack_multiple,priority,is_active,last_run_at," +
            "product:products(name,sku)," +
            "pick_loc:stock_locations!wms_replenishment_rules_pick_location_id_fkey(code)," +
            "source_loc:stock_locations!wms_replenishment_rules_source_location_id_fkey(code)"
        )
        .eq("business_id", currentBusiness!.id)
        .order("priority", { ascending: true });
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as RuleRow[];
    },
  });

  const { data: tasks, isLoading: tasksLoading } = useQuery({
    queryKey: ["wms-replen-tasks", currentBusiness?.id, warehouseFilter],
    enabled: !!currentBusiness?.id,
    refetchInterval: 15_000,
    queryFn: async () => {
      let q = supabase
        .from("wms_tasks")
        .select(
          "id,state,priority,quantity,created_at," +
            "product:products(name,sku)," +
            "source_loc:stock_locations!wms_tasks_source_location_id_fkey(code)," +
            "dest_loc:stock_locations!wms_tasks_destination_location_id_fkey(code)"
        )
        .eq("business_id", currentBusiness!.id)
        .eq("task_type", "replenish")
        .in("state", ["pending", "assigned", "in_progress"])
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(200);
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as TaskRow[];
    },
  });

  const generate = useMutation({
    mutationFn: async () => {
      if (!effectiveWarehouseId) throw new Error("Pick a warehouse first");
      const { data, error } = await supabase.rpc("plan_replenishment", {
        p_warehouse_id: effectiveWarehouseId,
        p_mode: "plan_and_dispatch",
      });
      if (error) throw error;
      return (data ?? {}) as unknown as {
        orders_created: number;
        orders_dispatched: number;
        faces_skipped: number;
      };
    },
    onSuccess: (r) => {
      toast.success(
        `Planned ${r?.orders_created ?? 0} order(s), dispatched ${r?.orders_dispatched ?? 0}; skipped ${r?.faces_skipped ?? 0}`,
      );
      qc.invalidateQueries({ queryKey: ["wms-replen-tasks"] });
      qc.invalidateQueries({ queryKey: ["wms-replen-rules"] });
      qc.invalidateQueries({ queryKey: ["wms-replen-orders"] });
      qc.invalidateQueries({ queryKey: ["wms-tasks"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });


  const toggleActive = useMutation({
    mutationFn: async (row: RuleRow) => {
      const { error } = await supabase
        .from("wms_replenishment_rules")
        .update({ is_active: !row.is_active })
        .eq("id", row.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-replen-rules"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        eyebrow="Warehouse"
        title="Replenishment"
        description="Keep pick faces stocked from bulk/reserve locations."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
              <SelectTrigger className="w-56"><SelectValue placeholder="All warehouses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All warehouses</SelectItem>
                {warehouses?.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" /> New rule
            </Button>
            <Button onClick={() => generate.mutate()} disabled={!effectiveWarehouseId || generate.isPending}>
              <Play className="h-4 w-4 mr-2" />
              {generate.isPending ? "Generating…" : "Generate tasks"}
            </Button>
          </div>
        }
      />
      <PageBody>
        <Section title="Rules" description="Min/max thresholds per pick face.">
          {rulesLoading ? (
            <LoadingState />
          ) : !rules || rules.length === 0 ? (
            <EmptyState icon={Waves} title="No rules yet" description="Create a rule to auto-generate replenishment tasks." />
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="text-left p-3">Product</th>
                        <th className="text-left p-3">Pick face</th>
                        <th className="text-left p-3">Source</th>
                        <th className="text-right p-3">Min</th>
                        <th className="text-right p-3">Max</th>
                        <th className="text-right p-3">Pack</th>
                        <th className="text-right p-3">Priority</th>
                        <th className="text-center p-3">Active</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map((r) => (
                        <tr key={r.id} className="border-t">
                          <td className="p-3">
                            <div className="font-medium">{r.product?.name ?? "—"}</div>
                            {r.product?.sku && <div className="text-xs text-muted-foreground">{r.product.sku}</div>}
                          </td>
                          <td className="p-3 font-mono text-xs">{r.pick_loc?.code ?? "—"}</td>
                          <td className="p-3 font-mono text-xs">{r.source_loc?.code ?? <span className="text-muted-foreground">auto</span>}</td>
                          <td className="p-3 text-right">{r.min_qty}</td>
                          <td className="p-3 text-right">{r.max_qty}</td>
                          <td className="p-3 text-right">{r.pack_multiple}</td>
                          <td className="p-3 text-right">{r.priority}</td>
                          <td className="p-3 text-center">
                            <Button size="sm" variant="ghost" onClick={() => toggleActive.mutate(r)}>
                              <Power className={`h-4 w-4 ${r.is_active ? "text-emerald-600" : "text-muted-foreground"}`} />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </Section>

        <Section title="Open replenishment tasks" description="Live queue — refreshes every 15s.">
          {tasksLoading ? (
            <LoadingState />
          ) : !tasks || tasks.length === 0 ? (
            <EmptyState icon={Waves} title="Nothing to replenish" description="All pick faces are above their minimum." />
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="text-left p-3">Product</th>
                        <th className="text-left p-3">From</th>
                        <th className="text-left p-3">To</th>
                        <th className="text-right p-3">Qty</th>
                        <th className="text-right p-3">Priority</th>
                        <th className="text-left p-3">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map((t) => (
                        <tr key={t.id} className="border-t">
                          <td className="p-3">
                            <div className="font-medium">{t.product?.name ?? "—"}</div>
                            {t.product?.sku && <div className="text-xs text-muted-foreground">{t.product.sku}</div>}
                          </td>
                          <td className="p-3 font-mono text-xs">{t.source_loc?.code ?? "—"}</td>
                          <td className="p-3 font-mono text-xs">{t.dest_loc?.code ?? "—"}</td>
                          <td className="p-3 text-right">{t.quantity ?? 0}</td>
                          <td className="p-3 text-right">{t.priority}</td>
                          <td className="p-3">
                            <StatusBadge tone={STATE_TONE[t.state as keyof typeof STATE_TONE] ?? "neutral"}>
                              {t.state}
                            </StatusBadge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </Section>
      </PageBody>

      <CreateRuleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultWarehouseId={effectiveWarehouseId}
        onCreated={() => qc.invalidateQueries({ queryKey: ["wms-replen-rules"] })}
      />
    </>
  );
}

// ---------------------------------------------------------------------------

interface CreateRuleDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultWarehouseId: string | null;
  onCreated: () => void;
}

function CreateRuleDialog({ open, onOpenChange, defaultWarehouseId, onCreated }: CreateRuleDialogProps) {
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const { user } = useAuth();
  const [warehouseId, setWarehouseId] = useState<string>(defaultWarehouseId ?? "");
  const [productId, setProductId] = useState<string>("");
  const [pickLocId, setPickLocId] = useState<string>("");
  const [sourceLocId, setSourceLocId] = useState<string>("");
  const [minQty, setMinQty] = useState<string>("10");
  const [maxQty, setMaxQty] = useState<string>("50");
  const [packMult, setPackMult] = useState<string>("1");
  const [priority, setPriority] = useState<string>("5");
  const [active, setActive] = useState(true);

  const { data: products } = useQuery({
    queryKey: ["wms-replen-products", currentBusiness?.id],
    enabled: open && !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,sku")
        .eq("business_id", currentBusiness!.id)
        .eq("is_active", true)
        .order("name")
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: locations } = useQuery({
    queryKey: ["wms-replen-locs", warehouseId],
    enabled: open && !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id,code,name,location_type")
        .eq("warehouse_id", warehouseId)
        .order("code")
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!currentBusiness || !warehouseId || !productId || !pickLocId) {
        throw new Error("Warehouse, product and pick face are required");
      }
      const wh = warehouses?.find((w) => w.id === warehouseId);
      if (!wh) throw new Error("Warehouse not found");
      const { error } = await supabase.from("wms_replenishment_rules").insert({
        organization_id: (wh as unknown as { organization_id: string }).organization_id ?? currentBusiness.organization_id,
        business_id: currentBusiness.id,
        warehouse_id: warehouseId,
        product_id: productId,
        pick_location_id: pickLocId,
        source_location_id: sourceLocId || null,
        min_qty: Number(minQty),
        max_qty: Number(maxQty),
        pack_multiple: Number(packMult) || 1,
        priority: Number(priority) || 5,
        is_active: active,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Rule created");
      onCreated();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New replenishment rule</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Warehouse</Label>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger>
              <SelectContent>
                {warehouses?.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Product</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
              <SelectContent>
                {products?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}{p.sku ? ` — ${p.sku}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Pick face</Label>
              <Select value={pickLocId} onValueChange={setPickLocId}>
                <SelectTrigger><SelectValue placeholder="Pick face bin" /></SelectTrigger>
                <SelectContent>
                  {locations?.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Source (optional)</Label>
              <Select value={sourceLocId} onValueChange={setSourceLocId}>
                <SelectTrigger><SelectValue placeholder="Auto" /></SelectTrigger>
                <SelectContent>
                  {locations?.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <div><Label>Min</Label><Input type="number" value={minQty} onChange={(e) => setMinQty(e.target.value)} /></div>
            <div><Label>Max</Label><Input type="number" value={maxQty} onChange={(e) => setMaxQty(e.target.value)} /></div>
            <div><Label>Pack</Label><Input type="number" value={packMult} onChange={(e) => setPackMult(e.target.value)} /></div>
            <div><Label>Priority</Label><Input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} /></div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={active} onCheckedChange={setActive} />
            <Label>Active</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
