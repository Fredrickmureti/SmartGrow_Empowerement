/**
 * Inventory Forecast — per-product on-hand / reserved / available / incoming
 * / outgoing / forecasted, scoped to the active branch when one is selected.
 * Drill-down opens the unified ProductDetailPanel.
 *
 * Honors `?product=<id>` for prefill from the product form CTA — scrolls to
 * and highlights that product, then clears the param.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { ProductDetailPanel } from "@/components/products/detail/ProductDetailPanel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Search, TrendingUp } from "lucide-react";
import { RefreshButton } from "@/components/ui/RefreshButton";

type Row = {
  id: string;
  name: string;
  sku: string | null;
  onHand: number;
  reserved: number;
  available: number;
  incoming: number;
  forecast: number;
  reorder: number | null;
};

export default function Forecast() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id;

  const [search, setSearch] = useState("");
  const [drawerProductId, setDrawerProductId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [highlightId, setHighlightId] = useState<string | null>(null);

  useEffect(() => {
    const pid = searchParams.get("product");
    if (!pid) return;
    setHighlightId(pid);
    setDrawerProductId(pid);
    const next = new URLSearchParams(searchParams);
    next.delete("product");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const { data: rows = [], isLoading } = useQuery<Row[]>({
    queryKey: ["inventory-forecast", orgId, businessId, branchId],
    queryFn: async () => {
      if (!orgId || !businessId) return [];

      // 1. Products in scope
      const { data: products, error: pErr } = await supabase
        .from("products")
        .select("id, name, sku, reorder_level, type, status, track_inventory")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .eq("type", "product")
        .eq("status", "active")
        .eq("track_inventory", true)
        .order("name");
      if (pErr) throw pErr;
      const ids = (products || []).map(p => p.id);
      if (ids.length === 0) return [];

      // 2. Per-warehouse on-hand + reserved (branch-scoped if active)
      let stockQ = supabase
        .from("warehouse_stock")
        .select("product_id, quantity, reserved_quantity")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .in("product_id", ids);
      if (branchId) stockQ = stockQ.eq("branch_id", branchId);
      const { data: stock } = await stockQ;
      const onHand = new Map<string, number>();
      const reserved = new Map<string, number>();
      for (const r of (stock || []) as any[]) {
        onHand.set(r.product_id, (onHand.get(r.product_id) || 0) + (r.quantity || 0));
        reserved.set(r.product_id, (reserved.get(r.product_id) || 0) + (r.reserved_quantity || 0));
      }

      // 3. Incoming from open POs (branch-scoped if active)
      let poQ = supabase
        .from("purchase_order_items")
        .select(
          "product_id, quantity, received_quantity, purchase_orders!inner(status, organization_id, business_id, branch_id)"
        )
        .in("product_id", ids)
        .eq("purchase_orders.organization_id", orgId)
        .eq("purchase_orders.business_id", businessId)
        .in("purchase_orders.status", ["draft", "sent", "partial_received"]);
      if (branchId) poQ = poQ.eq("purchase_orders.branch_id", branchId);
      const { data: poRows } = await poQ;
      const incoming = new Map<string, number>();
      for (const r of (poRows || []) as any[]) {
        const pending = Math.max(0, (r.quantity || 0) - (r.received_quantity || 0));
        incoming.set(r.product_id, (incoming.get(r.product_id) || 0) + pending);
      }

      return (products || []).map((p: any) => {
        const oh = onHand.get(p.id) || 0;
        const rv = reserved.get(p.id) || 0;
        const inc = incoming.get(p.id) || 0;
        const av = oh - rv;
        return {
          id: p.id,
          name: p.name,
          sku: p.sku,
          onHand: oh,
          reserved: rv,
          available: av,
          incoming: inc,
          forecast: av + inc,
          reorder: p.reorder_level,
        };
      });
    },
    enabled: !!orgId && !!businessId,
  });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(r =>
      r.name.toLowerCase().includes(s) || (r.sku || "").toLowerCase().includes(s)
    );
  }, [rows, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <TrendingUp className="h-5 w-5" /> Inventory Forecast
          </h1>
          <p className="text-sm text-muted-foreground">
            On-hand, reserved, available, incoming (open POs) and forecast per
            product. {currentBranch ? `Scope: ${currentBranch.name}.` : "Scope: all branches."}
          </p>
        </div>
        <RefreshButton
          queryKeyPrefixes={[
            ["inventory-forecast"] as const,
            ["warehouse-stock-detail"] as const,
            ["stock-levels-paginated"] as const,
          ]}
          tooltip="Refresh forecast"
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base">Products</CardTitle>
              <CardDescription>
                Forecast = available + incoming. Reserved already accounts for
                pending sales orders and POS holds.
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or SKU"
                className="pl-8"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              No tracked products in scope.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="text-right">Incoming</TableHead>
                  <TableHead className="text-right">Forecast</TableHead>
                  <TableHead className="text-right">Reorder@</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => {
                  const isLow = r.reorder != null && r.reorder > 0 && r.available <= r.reorder;
                  return (
                    <TableRow
                      key={r.id}
                      className={`cursor-pointer ${highlightId === r.id ? "bg-accent" : ""}`}
                      onClick={() => setDrawerProductId(r.id)}
                    >
                      <TableCell>
                        <div className="font-medium">{r.name}</div>
                        {r.sku && <div className="text-xs text-muted-foreground">{r.sku}</div>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.onHand}</TableCell>
                      <TableCell className="text-right tabular-nums text-warning">{r.reserved}</TableCell>
                      <TableCell className="text-right tabular-nums text-primary font-medium">
                        {r.available}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.incoming > 0 ? <span className="text-blue-600">+{r.incoming}</span> : 0}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">
                        {r.forecast}
                        {isLow && (
                          <Badge variant="outline" className="ml-2 border-warning text-warning text-[10px]">
                            Low
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {r.reorder ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ProductDetailPanel
        open={!!drawerProductId}
        onOpenChange={(o) => { if (!o) setDrawerProductId(null); }}
        productId={drawerProductId}
      />
    </div>
  );
}
