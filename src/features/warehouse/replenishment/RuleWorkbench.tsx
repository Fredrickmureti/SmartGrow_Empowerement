/**
 * Rule workbench (ADR 0108).
 *
 * Hierarchical rule surface for `wms_replenishment_rules`: scope badges
 * (warehouse | zone | category | product | pick_face), strategy, effective
 * window, emergency flag and auto-dispatch, plus rule creation. Rule rows are
 * plain RLS-scoped PostgREST writes — only *orders* and *tasks* are RPC-only.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, LoadingState } from "@/design-system";
import { Waves, Power } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useAuth } from "@/contexts/AuthContext";

export interface RuleRow {
  id: string;
  warehouse_id: string;
  scope: string;
  strategy: string;
  product_id: string | null;
  pick_location_id: string | null;
  source_location_id: string | null;
  zone_location_id: string | null;
  category_id: string | null;
  min_qty: number;
  max_qty: number;
  target_qty: number | null;
  pack_multiple: number;
  priority: number;
  is_active: boolean;
  is_emergency: boolean;
  auto_dispatch: boolean;
  effective_from: string | null;
  effective_to: string | null;
  last_run_at: string | null;
  product?: { name: string; sku: string | null } | null;
  pick_loc?: { code: string } | null;
  source_loc?: { code: string } | null;
}

const SCOPES = ["warehouse", "zone", "category", "product", "pick_face"] as const;
const STRATEGIES = ["min_max", "demand_driven", "topoff", "manual"] as const;

export function useReplenRules(businessId?: string | null, warehouseFilter = "all") {
  return useQuery({
    queryKey: ["wms-replen-rules", businessId, warehouseFilter],
    enabled: !!businessId,
    queryFn: async () => {
      let q = supabase
        .from("wms_replenishment_rules")
        .select(
          "id,warehouse_id,scope,strategy,product_id,pick_location_id,source_location_id,zone_location_id,category_id," +
            "min_qty,max_qty,target_qty,pack_multiple,priority,is_active,is_emergency,auto_dispatch,effective_from,effective_to,last_run_at," +
            "product:products(name,sku)," +
            "pick_loc:stock_locations!wms_replenishment_rules_pick_location_id_fkey(code)," +
            "source_loc:stock_locations!wms_replenishment_rules_source_location_id_fkey(code)",
        )
        .eq("business_id", businessId!)
        .order("priority", { ascending: true });
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as RuleRow[];
    },
  });
}

interface Props {
  rules: RuleRow[] | undefined;
  isLoading: boolean;
  createOpen: boolean;
  onCreateOpenChange: (v: boolean) => void;
  defaultWarehouseId: string | null;
}

export function RuleWorkbench({ rules, isLoading, createOpen, onCreateOpenChange, defaultWarehouseId }: Props) {
  const qc = useQueryClient();

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
      {isLoading ? (
        <LoadingState />
      ) : !rules || rules.length === 0 ? (
        <EmptyState icon={Waves} title="No rules yet" description="Create a rule so the planner has a threshold to work against." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="p-3 text-left">Scope</th>
                    <th className="p-3 text-left">Applies to</th>
                    <th className="p-3 text-left">Pick face</th>
                    <th className="p-3 text-left">Source</th>
                    <th className="p-3 text-right">Min</th>
                    <th className="p-3 text-right">Target</th>
                    <th className="p-3 text-right">Max</th>
                    <th className="p-3 text-right">Pack</th>
                    <th className="p-3 text-right">Priority</th>
                    <th className="p-3 text-left">Window</th>
                    <th className="p-3 text-center">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="secondary">{r.scope}</Badge>
                          <Badge variant="outline">{r.strategy}</Badge>
                          {r.is_emergency && <Badge variant="destructive">emergency</Badge>}
                          {r.auto_dispatch && <Badge>auto</Badge>}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="font-medium">{r.product?.name ?? "—"}</div>
                        {r.product?.sku && <div className="text-xs text-muted-foreground">{r.product.sku}</div>}
                      </td>
                      <td className="p-3 font-mono text-xs">{r.pick_loc?.code ?? "—"}</td>
                      <td className="p-3 font-mono text-xs">
                        {r.source_loc?.code ?? <span className="text-muted-foreground">auto</span>}
                      </td>
                      <td className="p-3 text-right">{r.min_qty}</td>
                      <td className="p-3 text-right">{r.target_qty ?? "—"}</td>
                      <td className="p-3 text-right">{r.max_qty}</td>
                      <td className="p-3 text-right">{r.pack_multiple}</td>
                      <td className="p-3 text-right">{r.priority}</td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {r.effective_from || r.effective_to
                          ? `${r.effective_from?.slice(0, 10) ?? "…"} → ${r.effective_to?.slice(0, 10) ?? "…"}`
                          : "always"}
                      </td>
                      <td className="p-3 text-center">
                        <Button size="sm" variant="ghost" onClick={() => toggleActive.mutate(r)} aria-label="Toggle rule">
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

      <CreateRuleDialog
        open={createOpen}
        onOpenChange={onCreateOpenChange}
        defaultWarehouseId={defaultWarehouseId}
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
  const [scope, setScope] = useState<string>("pick_face");
  const [strategy, setStrategy] = useState<string>("min_max");
  const [productId, setProductId] = useState<string>("");
  const [pickLocId, setPickLocId] = useState<string>("");
  const [sourceLocId, setSourceLocId] = useState<string>("");
  const [zoneLocId, setZoneLocId] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [minQty, setMinQty] = useState("10");
  const [targetQty, setTargetQty] = useState("");
  const [maxQty, setMaxQty] = useState("50");
  const [packMult, setPackMult] = useState("1");
  const [priority, setPriority] = useState("5");
  const [active, setActive] = useState(true);
  const [emergency, setEmergency] = useState(false);
  const [autoDispatch, setAutoDispatch] = useState(true);

  const { data: products } = useQuery({
    queryKey: ["wms-replen-products", currentBusiness?.id],
    enabled: open && !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,sku")
        .eq("business_id", currentBusiness!.id)
        .eq("status", "active")
        .order("name")
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: categories } = useQuery({
    queryKey: ["wms-replen-categories", currentBusiness?.id],
    enabled: open && !!currentBusiness?.id && scope === "category",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_categories")
        .select("id,name")
        .eq("business_id", currentBusiness!.id)
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
      if (!currentBusiness || !warehouseId) throw new Error("Warehouse is required");
      if (scope === "pick_face" && !pickLocId) throw new Error("A pick-face rule needs a pick face");
      if (scope === "product" && !productId) throw new Error("A product rule needs a product");
      if (scope === "category" && !categoryId) throw new Error("A category rule needs a category");
      if (scope === "zone" && !zoneLocId) throw new Error("A zone rule needs a zone");

      const wh = warehouses?.find((w) => w.id === warehouseId);
      if (!wh) throw new Error("Warehouse not found");

      const { error } = await supabase.from("wms_replenishment_rules").insert({
        organization_id:
          (wh as unknown as { organization_id: string }).organization_id ?? currentBusiness.organization_id,
        business_id: currentBusiness.id,
        warehouse_id: warehouseId,
        scope: scope as RuleRow["scope"],
        strategy: strategy as RuleRow["strategy"],
        product_id: productId || null,
        pick_location_id: pickLocId || null,
        source_location_id: sourceLocId || null,
        zone_location_id: zoneLocId || null,
        category_id: categoryId || null,
        min_qty: Number(minQty),
        max_qty: Number(maxQty),
        target_qty: targetQty ? Number(targetQty) : null,
        pack_multiple: Number(packMult) || 1,
        priority: Number(priority) || 5,
        is_active: active,
        is_emergency: emergency,
        auto_dispatch: autoDispatch,
        created_by: user?.id ?? null,
      } as never);
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
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          <div className="min-w-0 grid grid-cols-2 gap-3">
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
              <Label>Scope</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SCOPES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Strategy</Label>
            <Select value={strategy} onValueChange={setStrategy}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STRATEGIES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {(scope === "product" || scope === "pick_face") && (
            <div>
              <Label>Product{scope === "pick_face" ? " (optional)" : ""}</Label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                <SelectContent>
                  {products?.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}{p.sku ? ` — ${p.sku}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {scope === "category" && (
            <div>
              <Label>Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {categories?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {scope === "zone" && (
            <div>
              <Label>Zone</Label>
              <Select value={zoneLocId} onValueChange={setZoneLocId}>
                <SelectTrigger><SelectValue placeholder="Select zone" /></SelectTrigger>
                <SelectContent>
                  {locations?.map((l) => <SelectItem key={l.id} value={l.id}>{l.code}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="min-w-0 grid grid-cols-2 gap-3">
            <div>
              <Label>Pick face{scope === "pick_face" ? "" : " (optional)"}</Label>
              <Select value={pickLocId} onValueChange={setPickLocId}>
                <SelectTrigger><SelectValue placeholder="Pick face bin" /></SelectTrigger>
                <SelectContent>
                  {locations?.map((l) => <SelectItem key={l.id} value={l.id}>{l.code}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Source (optional)</Label>
              <Select value={sourceLocId} onValueChange={setSourceLocId}>
                <SelectTrigger><SelectValue placeholder="Auto (FEFO)" /></SelectTrigger>
                <SelectContent>
                  {locations?.map((l) => <SelectItem key={l.id} value={l.id}>{l.code}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="min-w-0 grid grid-cols-2 gap-3 @xl/page:grid-cols-3 @4xl/page:grid-cols-5">
            <div><Label>Min</Label><Input type="number" value={minQty} onChange={(e) => setMinQty(e.target.value)} /></div>
            <div><Label>Target</Label><Input type="number" value={targetQty} onChange={(e) => setTargetQty(e.target.value)} placeholder="max" /></div>
            <div><Label>Max</Label><Input type="number" value={maxQty} onChange={(e) => setMaxQty(e.target.value)} /></div>
            <div><Label>Pack</Label><Input type="number" value={packMult} onChange={(e) => setPackMult(e.target.value)} /></div>
            <div><Label>Prio</Label><Input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} /></div>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-2">
              <Switch checked={active} onCheckedChange={setActive} id="rule-active" />
              <Label htmlFor="rule-active">Active</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={emergency} onCheckedChange={setEmergency} id="rule-emergency" />
              <Label htmlFor="rule-emergency">Emergency</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={autoDispatch} onCheckedChange={setAutoDispatch} id="rule-auto" />
              <Label htmlFor="rule-auto">Auto-dispatch</Label>
            </div>
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
