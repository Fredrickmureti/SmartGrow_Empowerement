import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Package, Warehouse } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { useProductPackagingBatch } from "@/hooks/inventory/useProductPackagingBatch";
import { formatQtyWithPacks, formatBaseQty } from "@/lib/inventory/formatQty";

interface WarehouseStockDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  warehouseId: string | null;
  warehouseName: string | null;
  organizationId: string | undefined;
}

export function WarehouseStockDrawer({
  open,
  onOpenChange,
  warehouseId,
  warehouseName,
  organizationId,
}: WarehouseStockDrawerProps) {
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLevel, setEditLevel] = useState<string>("");
  const [editQty, setEditQty] = useState<string>("");
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();

  const { data: stockItems = [], isLoading } = useQuery({
    queryKey: ["warehouse-stock-detail", warehouseId],
    queryFn: async () => {
      if (!warehouseId || !organizationId || !businessId) return [];
      // Defensive: resolve the warehouse's branch_id and filter by it too,
      // so a misconfigured (branch_id IS NULL) warehouse cannot leak stock
      // across branches in this drawer. See ARCHITECTURE.md §"branches".
      const { data: wh } = await supabase
        .from("warehouses")
        .select("branch_id")
        .eq("id", warehouseId)
        .maybeSingle();
      let query = supabase
        .from("warehouse_stock")
        .select("*, products(id, name, sku, cost_price, reorder_level)")
        .eq("warehouse_id", warehouseId)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);
      if (wh?.branch_id) {
        query = query.eq("branch_id", wh.branch_id);
      }
      const { data, error } = await query.order("quantity", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!warehouseId && !!organizationId && !!businessId && open,
  });

  // Stage C.12 — per-warehouse reorder threshold edit.
  // Writes to warehouse_stock (the per-(warehouse, product) row), NEVER to
  // products.reorder_level which is now a seed default only.
  const updateReorder = useMutation({
    mutationFn: async (vars: { id: string; reorder_level: number; reorder_quantity: number }) => {
      const { error } = await supabase
        .from("warehouse_stock")
        .update({
          reorder_level: vars.reorder_level,
          reorder_quantity: vars.reorder_quantity,
        })
        .eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reorder threshold updated for this warehouse");
      queryClient.invalidateQueries({ queryKey: ["warehouse-stock-detail", warehouseId] });
      setEditingId(null);
    },
    onError: (e: Error) => toast.error(`Failed: ${normalizeError(e).message}`),
  });

  const startEdit = (item: any) => {
    setEditingId(item.id);
    setEditLevel(String(item.reorder_level ?? item.products?.reorder_level ?? 0));
    setEditQty(String(item.reorder_quantity ?? 0));
  };

  const filtered = stockItems.filter((item: any) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      item.products?.name?.toLowerCase().includes(q) ||
      item.products?.sku?.toLowerCase().includes(q)
    );
  });

  const totalQty = filtered.reduce((s: number, i: any) => s + (i.quantity || 0), 0);
  const totalReserved = filtered.reduce((s: number, i: any) => s + (i.reserved_quantity || 0), 0);

  const productIds = filtered.map((i: any) => i.products?.id).filter(Boolean) as string[];
  const { packsByProduct } = useProductPackagingBatch(productIds);
  const fmt = (productId: string | undefined, qty: number) => {
    const packs = productId ? packsByProduct.get(productId) : undefined;
    return formatQtyWithPacks(qty, packs ?? [], "ea");
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Warehouse className="h-5 w-5" />
          {warehouseName || "Warehouse"} Stock
        </span>
      }
      description={`${filtered.length} product(s) • ${totalQty} total units • ${totalReserved} reserved`}
    >
      <div className="space-y-4">

          <Input
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Package className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No stock in this warehouse</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">On Hand</TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="text-right">Reorder At</TableHead>
                  <TableHead className="text-right">Reorder Qty</TableHead>
                  <TableHead>Bin</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item: any) => {
                  const available = (item.quantity || 0) - (item.reserved_quantity || 0);
                  const reorderLevel = item.reorder_level ?? item.products?.reorder_level ?? 0;
                  const isLow = reorderLevel > 0 && item.quantity <= reorderLevel;
                  const isEditing = editingId === item.id;
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium text-sm">{item.products?.name || "—"}</p>
                          {item.products?.sku && (
                            <p className="text-xs text-muted-foreground">{item.products.sku}</p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={isLow ? "text-destructive font-medium" : ""}>
                          {fmt(item.products?.id, item.quantity || 0)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {item.reserved_quantity > 0 ? (
                          <span className="text-orange-600 font-medium">
                            {fmt(item.products?.id, item.reserved_quantity)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {fmt(item.products?.id, available)}
                      </TableCell>
                      <TableCell className="text-right">
                        {isEditing ? (
                          <Input
                            type="number"
                            value={editLevel}
                            onChange={(e) => setEditLevel(e.target.value)}
                            className="h-8 w-20 ml-auto"
                          />
                        ) : (
                          <span className="text-muted-foreground">{formatBaseQty(reorderLevel, "ea")}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {isEditing ? (
                          <Input
                            type="number"
                            value={editQty}
                            onChange={(e) => setEditQty(e.target.value)}
                            className="h-8 w-20 ml-auto"
                          />
                        ) : (
                          <span className="text-muted-foreground">{item.reorder_quantity ?? 0}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {item.bin_location || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {isEditing ? (
                          <div className="flex gap-1 justify-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingId(null)}
                              disabled={updateReorder.isPending}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              onClick={() =>
                                updateReorder.mutate({
                                  id: item.id,
                                  reorder_level: Number(editLevel) || 0,
                                  reorder_quantity: Number(editQty) || 0,
                                })
                              }
                              disabled={updateReorder.isPending}
                            >
                              Save
                            </Button>
                          </div>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => startEdit(item)}>
                            Edit
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
      </div>
    </DetailSheet>

  );
}
