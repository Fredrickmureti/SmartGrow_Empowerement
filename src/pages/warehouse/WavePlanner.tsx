/**
 * WavePlanner — Phase 3 supervisor screen.
 *
 * Groups open sales orders into a pick wave and releases them via
 * `create_pick_wave` + `release_pick_wave`. Release is the only
 * sanctioned path — it reserves stock (warehouse-scoped), generates
 * `pick` tasks by source bin, and emits `warehouse.wave.released`.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useCreateAndReleaseWave } from "@/features/warehouse/aggregates/useDomainOperations";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ListChecks, Rocket } from "lucide-react";
import { CancelAggregateButton } from "@/features/warehouse/aggregates/CancelAggregateButton";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";

interface OpenSO {
  id: string;
  so_number: string;
  order_date: string | null;
  status: string;
  total: number | null;
  contact: { name: string | null } | null;
}

interface WaveRow {
  id: string;
  wave_number: string;
  state: string;
  row_version: number;
  strategy: string;
  released_at: string | null;
  completed_at: string | null;
  created_at: string;
  warehouse_id: string;
}

const WAVE_TONE: Record<string, "neutral" | "info" | "warning" | "success" | "danger"> = {
  draft: "neutral",
  released: "info",
  picking: "warning",
  picked: "info",
  packing: "warning",
  packed: "success",
  cancelled: "danger",
};

export default function WavePlanner() {
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: openSOs, isLoading: sosLoading } = useQuery({
    queryKey: ["wms-open-sos", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_orders")
        .select("id, so_number, order_date, status, total, contact:contact_id(name)")
        .eq("business_id", currentBusiness!.id)
        .in("status", ["confirmed", "approved", "processing", "open"])
        .order("order_date", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as OpenSO[];
    },
  });

  const { data: waves, isLoading: wavesLoading } = useQuery({
    queryKey: ["wms-pick-waves", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_waves")
        .select("id, wave_number, state, row_version, strategy, released_at, completed_at, created_at, warehouse_id")
        .eq("business_id", currentBusiness!.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as WaveRow[];
    },
  });

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const createAndRelease = useCreateAndReleaseWave();
  const handleRelease = () => {
    if (!warehouseId) return toast.error("Pick a warehouse");
    if (selected.size === 0) return toast.error("Select at least one sales order");
    createAndRelease.mutate(
      { warehouseId, salesOrderIds: Array.from(selected) },
      {
        onSuccess: () => {
          toast.success("Wave released — pick tasks generated");
          setSelected(new Set());
        },
      },
    );
  };

  const canRelease = warehouseId && selected.size > 0;
  const warehouseName = useMemo(
    () => warehouses.find((w) => w.id === warehouseId)?.name ?? "",
    [warehouses, warehouseId],
  );

  return (
    <>
      <PageHeader
        title="Wave planner"
        description="Batch open sales orders into a pick wave. Release reserves stock and generates pick tasks per bin."
      />
      <PageBody>
        <Section
          title="Draft wave"
          description={warehouseName ? `Fulfilling from ${warehouseName}` : "Choose a warehouse and pick sales orders."}
        >
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={warehouseId} onValueChange={setWarehouseId}>
                  <SelectTrigger className="w-[220px]"><SelectValue placeholder="Warehouse" /></SelectTrigger>
                  <SelectContent>
                    {warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="text-sm text-muted-foreground">{selected.size} selected</div>
                <div className="flex-1" />
                <Button disabled={!canRelease || createAndRelease.isPending} onClick={handleRelease}>
                  <Rocket className="h-4 w-4 mr-2" /> Create &amp; release
                </Button>
              </div>

              {sosLoading ? (
                <LoadingState />
              ) : (openSOs ?? []).length === 0 ? (
                <EmptyState
                  icon={ListChecks}
                  title="No open sales orders"
                  description="Confirmed sales orders will show up here."
                />
              ) : (
                <div className="max-h-[45vh] overflow-auto border rounded">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted/50">
                      <tr className="text-left">
                        <th className="p-2 w-8" />
                        <th className="p-2">SO#</th>
                        <th className="p-2">Customer</th>
                        <th className="p-2">Date</th>
                        <th className="p-2">Status</th>
                        <th className="p-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openSOs!.map((so) => (
                        <tr key={so.id} className="border-t hover:bg-muted/20">
                          <td className="p-2">
                            <Checkbox checked={selected.has(so.id)} onCheckedChange={() => toggle(so.id)} />
                          </td>
                          <td className="p-2 font-mono">{so.so_number}</td>
                          <td className="p-2">{so.contact?.name ?? "—"}</td>
                          <td className="p-2">{so.order_date ?? "—"}</td>
                          <td className="p-2 capitalize">{so.status}</td>
                          <td className="p-2 text-right font-mono">{Number(so.total ?? 0).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </Section>

        <Section title="Recent waves" description="Live state of the last 50 waves. Click a wave to work its pick list.">
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-sm">Waves</CardTitle></CardHeader>
            <CardContent className="p-0">
              {wavesLoading ? (
                <LoadingState />
              ) : (waves ?? []).length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No waves yet.</div>
              ) : (
                <ul className="divide-y">
                  {waves!.map((w) => (
                    <li key={w.id} className="flex items-center gap-3 p-3">
                      <StatusBadge tone={WAVE_TONE[w.state] ?? "neutral"}>{w.state}</StatusBadge>
                      <Link to={`/warehouse-app/picks/${w.id}`} className="font-mono hover:underline">{w.wave_number}</Link>
                      <span className="text-xs text-muted-foreground">{w.strategy}</span>
                      <div className="flex-1" />
                      <span className="text-xs text-muted-foreground">
                        {w.released_at ? `released ${new Date(w.released_at).toLocaleString()}` : "drafted"}
                      </span>
                      {w.state === "picked" ? (
                        <Button asChild size="sm" variant="outline"><Link to={`/warehouse-app/pack/${w.id}`}>Pack</Link></Button>
                      ) : null}
                      <CancelAggregateButton
                        aggregate="wave"
                        id={w.id}
                        rowVersion={w.row_version}
                        state={w.state}
                        onCancelled={() => queryClient.invalidateQueries({ queryKey: ["wms-waves"] })}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </Section>
      </PageBody>
    </>
  );
}
