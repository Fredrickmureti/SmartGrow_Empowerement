/**
 * Slotting — Phase 8 read-only ABC velocity analytics.
 *
 * Reads `wms_slotting_velocity_view` (rolling 90-day pick velocity per
 * product per warehouse, classified A/B/C by percent-rank). Read-only:
 * no writes to any WMS or Inventory table.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
  StatusBadge,
} from "@/design-system";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Gauge } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";

interface VelocityRow {
  warehouse_id: string | null;
  business_id: string | null;
  product_id: string | null;
  pick_count: number | null;
  pick_qty: number | null;
  pct_by_count: number | null;
  velocity_class: string | null;
  product?: { name: string; sku: string | null } | null;
}

const CLASS_TONE = {
  A: "success",
  B: "warning",
  C: "neutral",
} as const;

export default function Slotting() {
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [classFilter, setClassFilter] = useState<string>("all");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms-slotting", currentBusiness?.id, warehouseFilter, classFilter],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_slotting_velocity_view")
        .select("warehouse_id,business_id,product_id,pick_count,pick_qty,pct_by_count,velocity_class,product:products(name,sku)")
        .eq("business_id", currentBusiness!.id)
        .order("pick_count", { ascending: false })
        .limit(500);
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      if (classFilter !== "all") q = q.eq("velocity_class", classFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as VelocityRow[];
    },
  });

  const counts = useMemo(() => {
    const c = { A: 0, B: 0, C: 0 };
    for (const r of rows ?? []) {
      const k = r.velocity_class as "A" | "B" | "C" | null;
      if (k && c[k] !== undefined) c[k] += 1;
    }
    return c;
  }, [rows]);

  return (
    <>
      <PageHeader
        eyebrow="Warehouse"
        title="Slotting velocity"
        description="Rolling 90-day pick frequency classified A/B/C. Fast-movers should sit closest to dispatch."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
              <SelectTrigger className="w-56"><SelectValue placeholder="All warehouses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All warehouses</SelectItem>
                {warehouses?.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={classFilter} onValueChange={setClassFilter}>
              <SelectTrigger className="w-40"><SelectValue placeholder="All classes" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All classes</SelectItem>
                <SelectItem value="A">A — fast</SelectItem>
                <SelectItem value="B">B — medium</SelectItem>
                <SelectItem value="C">C — slow</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />
      <PageBody>
        <div className="min-w-0 grid grid-cols-1 @2xl/page:grid-cols-3 gap-4">
          {(["A", "B", "C"] as const).map((k) => (
            <Card key={k}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Class {k}</div>
                  <div className="text-2xl font-semibold">{counts[k]}</div>
                </div>
                <StatusBadge tone={CLASS_TONE[k]}>{k}</StatusBadge>
              </CardContent>
            </Card>
          ))}
        </div>

        <Section title="Products by velocity" description="Ranked by pick count.">
          {isLoading ? (
            <LoadingState />
          ) : !rows || rows.length === 0 ? (
            <EmptyState icon={Gauge} title="No pick history" description="Complete some pick tasks to build velocity analytics." />
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="text-left p-3">Product</th>
                        <th className="text-right p-3">Picks (90d)</th>
                        <th className="text-right p-3">Qty picked</th>
                        <th className="text-right p-3">Percentile</th>
                        <th className="text-center p-3">Class</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={`${r.warehouse_id}-${r.product_id}`} className="border-t">
                          <td className="p-3">
                            <div className="font-medium">{r.product?.name ?? "—"}</div>
                            {r.product?.sku && <div className="text-xs text-muted-foreground">{r.product.sku}</div>}
                          </td>
                          <td className="p-3 text-right">{r.pick_count ?? 0}</td>
                          <td className="p-3 text-right">{r.pick_qty ?? 0}</td>
                          <td className="p-3 text-right">{r.pct_by_count != null ? `${Math.round((r.pct_by_count ?? 0) * 100)}%` : "—"}</td>
                          <td className="p-3 text-center">
                            <StatusBadge tone={CLASS_TONE[(r.velocity_class as "A" | "B" | "C") ?? "C"] ?? "neutral"}>
                              {r.velocity_class ?? "C"}
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
    </>
  );
}
