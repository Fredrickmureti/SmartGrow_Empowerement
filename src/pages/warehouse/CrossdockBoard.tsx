/**
 * Cross-dock Board — Phase 12.
 *
 * Shows open cross-dock opportunities detected when a GRN is completed
 * and the same product has an unfulfilled sales order line waiting.
 * Operators can confirm the stage move (bypass put-away) or cancel it
 * back to normal put-away flow.
 *
 * Writes go exclusively through:
 *   - confirm_crossdock_stage(opportunity_id)
 *   - cancel_crossdock_opportunity(opportunity_id, reason)
 *   - evaluate_crossdock_on_grn(grn_id)  (manual re-scan)
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Truck, Check, X } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";

interface Opportunity {
  id: string;
  warehouse_id: string;
  grn_id: string;
  grn_line_id: string;
  product_id: string;
  quantity: number;
  sales_order_id: string | null;
  sales_order_item_id: string | null;
  status: "open" | "staged" | "cancelled";
  matched_at: string;
  staged_at: string | null;
  cancelled_at: string | null;
}

export default function CrossdockBoard() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("open");

  const { data, isLoading } = useQuery({
    queryKey: ["wms-crossdock", currentBusiness?.id, warehouseFilter, statusFilter],
    enabled: !!currentBusiness?.id,
    refetchInterval: 15_000,
    queryFn: async () => {
      let q = supabase
        .from("wms_crossdock_opportunities")
        .select("id,warehouse_id,grn_id,grn_line_id,product_id,quantity,sales_order_id,sales_order_item_id,status,matched_at,staged_at,cancelled_at")
        .eq("business_id", currentBusiness!.id)
        .order("matched_at", { ascending: false });
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      if (statusFilter !== "all") q = q.eq("status", statusFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Opportunity[];
    },
  });

  const confirmStage = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("confirm_crossdock_stage", { p_opportunity_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Cross-dock staged");
      qc.invalidateQueries({ queryKey: ["wms-crossdock"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_crossdock_opportunity", {
        p_opportunity_id: id,
        p_reason: "Cancelled from board",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Opportunity cancelled");
      qc.invalidateQueries({ queryKey: ["wms-crossdock"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const kpis = useMemo(() => {
    const rows = data ?? [];
    return {
      open: rows.filter((r) => r.status === "open").length,
      staged: rows.filter((r) => r.status === "staged").length,
      cancelled: rows.filter((r) => r.status === "cancelled").length,
    };
  }, [data]);

  return (
    <>
      <PageHeader
        title="Cross-dock opportunities"
        description="Inbound receipts that can bypass put-away and ship straight to open sales orders."
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-3 mb-4">
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
          <div className="w-40">
            <Label>Status</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="staged">Staged</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto flex gap-2 text-sm">
            <Badge variant="outline">Open: {kpis.open}</Badge>
            <Badge variant="outline">Staged: {kpis.staged}</Badge>
            <Badge variant="outline">Cancelled: {kpis.cancelled}</Badge>
          </div>
        </div>

        {isLoading ? (
          <LoadingState />
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="No opportunities"
            description="Cross-dock candidates appear here automatically when a GRN is completed and matches an open sales order."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Matched</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Sales order</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(r.matched_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.product_id.slice(0, 8)}</TableCell>
                  <TableCell>{Number(r.quantity)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.sales_order_id ? r.sales_order_id.slice(0, 8) : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={
                      r.status === "open" ? "default" :
                      r.status === "staged" ? "secondary" : "outline"
                    }>{r.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {r.status === "open" && (
                      <div className="flex gap-2 justify-end">
                        <Button size="sm" onClick={() => confirmStage.mutate(r.id)}>
                          <Check className="h-4 w-4 mr-1" /> Stage
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => cancel.mutate(r.id)}>
                          <X className="h-4 w-4 mr-1" /> Cancel
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PageBody>
    </>
  );
}
