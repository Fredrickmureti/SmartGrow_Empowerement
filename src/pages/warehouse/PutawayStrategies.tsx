/**
 * PutawayStrategies — the configuration surface for the putaway engine.
 *
 * The old engine was three hardcoded SQL rules. This page exposes the real
 * contract: an ordered, per-warehouse strategy chain the warehouse manager
 * owns (fixed bin → cold chain → hazmat → heavy → consolidate → FEFO →
 * velocity → category → empty → nearest → bulk → overflow → priority), plus
 * the product storage profiles the feasibility engine reads.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Gauge } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  PageHeader, PageBody, Section, LoadingState, EmptyState, StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";

interface StrategyRow {
  id: string;
  name: string;
  strategy_type: string;
  sequence: number;
  is_active: boolean;
  warehouse_id: string | null;
}

const EXPLAIN: Record<string, string> = {
  fixed_bin: "Product has a permanently assigned home bin.",
  cold_chain: "Temperature-controlled goods only go to matching bins.",
  hazmat_zone: "Hazard class must be permitted in the bin.",
  heavy_zone: "Heavy units go to ground-level positions.",
  consolidate: "Join stock of the same product already stored.",
  fefo_zone: "Expiry-tracked goods go to the expiry-managed zone.",
  velocity_slot: "Follows the slotting rules for this velocity class.",
  same_category: "Keep the category together.",
  empty_bin: "Prefer a clean empty bin.",
  nearest: "Shortest travel by pick sequence.",
  bulk: "Bulk storage area.",
  overflow: "Overflow area when the primaries are full.",
  general_priority: "Fallback: highest putaway priority bin that fits.",
};

export default function PutawayStrategies() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState<string>("");
  const active = warehouseId || warehouses[0]?.id || "";

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms-putaway-strategies", currentBusiness?.id, active],
    enabled: !!currentBusiness?.id && !!active,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_putaway_strategies")
        .select("id, name, strategy_type, sequence, is_active, warehouse_id")
        .eq("business_id", currentBusiness!.id)
        .eq("warehouse_id", active)
        .order("sequence");
      if (error) throw error;
      return (data ?? []) as unknown as StrategyRow[];
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["wms-putaway-strategies"] });

  const toggle = useMutation({
    mutationFn: async (r: StrategyRow) => {
      const { error } = await supabase
        .from("wms_putaway_strategies")
        .update({ is_active: !r.is_active })
        .eq("id", r.id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Update failed"),
  });

  const swap = useMutation({
    mutationFn: async ({ a, b }: { a: StrategyRow; b: StrategyRow }) => {
      const { error: e1 } = await supabase
        .from("wms_putaway_strategies").update({ sequence: b.sequence }).eq("id", a.id);
      if (e1) throw e1;
      const { error: e2 } = await supabase
        .from("wms_putaway_strategies").update({ sequence: a.sequence }).eq("id", b.id);
      if (e2) throw e2;
    },
    onSuccess: refresh,
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Reorder failed"),
  });

  const seed = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("wms_ensure_default_putaway_strategies", {
        p_warehouse_id: active,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Default strategies created"); refresh(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not seed"),
  });

  const list = rows ?? [];

  return (
    <>
      <PageHeader
        title="Putaway strategies"
        description="The ordered rule chain the putaway engine runs for this warehouse. The first strategy that produces a bin the goods physically fit into wins."
        actions={
          <Select value={active} onValueChange={setWarehouseId}>
            <SelectTrigger className="w-full @xl/page:w-[220px]">
              <SelectValue placeholder="Warehouse" />
            </SelectTrigger>
            <SelectContent>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <PageBody>
        <Section>
          {isLoading ? (
            <LoadingState />
          ) : list.length === 0 ? (
            <EmptyState
              icon={Gauge}
              title="No strategies configured"
              description="Create the default enterprise strategy chain for this warehouse."
              action={
                <Button disabled={!active || seed.isPending} onClick={() => seed.mutate()}>
                  Create defaults
                </Button>
              }
            />
          ) : (
            <ul className="divide-y rounded border">
              {list.map((r, i) => (
                <li key={r.id} className="flex items-center gap-3 p-3">
                  <span className="w-8 text-xs text-muted-foreground">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.name}</span>
                      <StatusBadge tone={r.is_active ? "success" : "neutral"}>
                        {r.is_active ? "active" : "off"}
                      </StatusBadge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {EXPLAIN[r.strategy_type] ?? r.strategy_type}
                    </p>
                  </div>
                  <Button
                    size="icon" variant="ghost"
                    disabled={i === 0 || swap.isPending}
                    onClick={() => swap.mutate({ a: r, b: list[i - 1] })}
                    aria-label="Move up"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon" variant="ghost"
                    disabled={i === list.length - 1 || swap.isPending}
                    onClick={() => swap.mutate({ a: r, b: list[i + 1] })}
                    aria-label="Move down"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Switch
                    checked={r.is_active}
                    onCheckedChange={() => toggle.mutate(r)}
                    aria-label={`Toggle ${r.name}`}
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </PageBody>
    </>
  );
}