/**
 * Replenishment control centre — supervisor workspace (ADR 0108).
 *
 * Composition only: KPI strip, live order queue (approve / dispatch / cancel
 * via `wms_transition_replen_order`), pick-face health board, and the
 * hierarchical rule workbench. Planning runs through `plan_replenishment`;
 * order and task state is refreshed by `useWmsRealtimeSync` — no polling.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { PageHeader, PageBody, Section } from "@/design-system";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Plus, Play } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";
import { ReplenKpiStrip } from "@/features/warehouse/replenishment/ReplenKpiStrip";
import { ReplenOrderQueue } from "@/features/warehouse/replenishment/ReplenOrderQueue";
import { PickFaceHealthBoard } from "@/features/warehouse/replenishment/PickFaceHealthBoard";
import { RuleWorkbench, useReplenRules } from "@/features/warehouse/replenishment/RuleWorkbench";
import { useReplenOrders } from "@/features/warehouse/replenishment/useReplenOrders";

export default function Replenishment() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);

  const effectiveWarehouseId = useMemo(() => {
    if (warehouseFilter !== "all") return warehouseFilter;
    return warehouses?.[0]?.id ?? null;
  }, [warehouseFilter, warehouses]);

  const { data: rules, isLoading: rulesLoading } = useReplenRules(currentBusiness?.id, warehouseFilter);
  const { data: orders, isLoading: ordersLoading } = useReplenOrders(currentBusiness?.id, warehouseFilter);

  const plan = useMutation({
    mutationFn: async (mode: "plan" | "plan_and_dispatch") => {
      if (!effectiveWarehouseId) throw new Error("Pick a warehouse first");
      const { data, error } = await supabase.rpc("plan_replenishment", {
        p_warehouse_id: effectiveWarehouseId,
        p_mode: mode,
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
      qc.invalidateQueries({ queryKey: ["wms-replen-orders"] });
      qc.invalidateQueries({ queryKey: ["wms-replen-tasks"] });
      qc.invalidateQueries({ queryKey: ["wms-replen-rules"] });
      qc.invalidateQueries({ queryKey: ["wms_tasks"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openOrders = orders ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Warehouse"
        title="Replenishment control centre"
        description="Plan pick-face refills, approve the queue, and track execution to the bin."
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
              <Plus className="mr-2 h-4 w-4" /> New rule
            </Button>
            <Button
              variant="outline"
              onClick={() => plan.mutate("plan")}
              disabled={!effectiveWarehouseId || plan.isPending}
            >
              Plan only
            </Button>
            <Button
              onClick={() => plan.mutate("plan_and_dispatch")}
              disabled={!effectiveWarehouseId || plan.isPending}
            >
              <Play className="mr-2 h-4 w-4" />
              {plan.isPending ? "Planning…" : "Plan & dispatch"}
            </Button>
          </div>
        }
      />
      <PageBody>
        <ReplenKpiStrip orders={openOrders} />

        <Section title="Work queue" description="Open replenishment orders — select rows for bulk actions.">
          <ReplenOrderQueue orders={openOrders} isLoading={ordersLoading} />
        </Section>

        <Section title="Pick-face health" description="Most exposed pick faces first, from the planner's decision trace.">
          <PickFaceHealthBoard orders={openOrders} />
        </Section>

        <Section title="Rules" description="Hierarchy: pick face beats product beats category beats zone beats warehouse.">
          <RuleWorkbench
            rules={rules}
            isLoading={rulesLoading}
            createOpen={createOpen}
            onCreateOpenChange={setCreateOpen}
            defaultWarehouseId={effectiveWarehouseId}
          />
        </Section>
      </PageBody>
    </>
  );
}
