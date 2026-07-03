import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, ArrowUp, ArrowDown, User, Calendar, Warehouse, FileText } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { format } from "date-fns";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { SourceDocumentBadge } from "./SourceDocumentBadge";
import { formatTransactionQty } from "@/lib/inventory/formatQty";

interface MovementDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  movementId: string | null;
  onOpenProductDrawer?: (productId: string) => void;
  onOpenWarehouseDrawer?: (warehouseId: string, warehouseName: string) => void;
  onOpenSourceDocDrawer?: (type: string, id: string) => void;
}

export function MovementDetailDrawer({
  open,
  onOpenChange,
  movementId,
  onOpenProductDrawer,
  onOpenWarehouseDrawer,
  onOpenSourceDocDrawer,
}: MovementDetailDrawerProps) {
  const { formatCurrency } = useCurrency();

  const { data: movement, isLoading } = useQuery({
    queryKey: ["movement-detail", movementId],
    queryFn: async () => {
      if (!movementId) return null;
      const { data, error } = await supabase
        .from("stock_movements")
        .select(`
          *,
          products(id, name, sku, cost_price, base_uom_id),
          warehouses(id, name, code),
          source_packaging:product_packaging!stock_movements_source_packaging_id_fkey(id, name, qty_in_base_uom),
          source_uom:units_of_measure!stock_movements_source_uom_id_fkey(id, code, name)
        `)
        .eq("id", movementId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!movementId && open,
  });

  const { data: relatedMovements = [] } = useQuery({
    queryKey: ["related-movements", movementId, movement?.reference_id],
    queryFn: async () => {
      if (!movement?.reference_id || !movementId) return [];
      const { data, error } = await supabase
        .from("stock_movements")
        .select("id, movement_type, quantity, warehouse_id, warehouses(name), products(name)")
        .eq("reference_id", movement.reference_id)
        .neq("id", movementId)
        .order("created_at");
      if (error) return [];
      return data || [];
    },
    enabled: !!movement?.reference_id && !!movementId && open,
  });

  const { data: creator } = useQuery({
    queryKey: ["profile", movement?.created_by],
    queryFn: async () => {
      if (!movement?.created_by) return null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", movement.created_by)
        .maybeSingle();
      return data;
    },
    enabled: !!movement?.created_by && open,
  });

  const getMovementLabel = (type: string) => {
    const labels: Record<string, string> = {
      purchase: "Purchase", receipt: "Receipt", sale: "Sale", pos_sale: "POS Sale",
      delivery: "Delivery", adjustment: "Adjustment", count: "Count", return_in: "Return In",
      pos_return: "POS Return", return_out: "Return Out", transfer: "Transfer",
      scrap: "Scrap", opening: "Opening",
    };
    return labels[type] || type;
  };

  const product = (movement as any)?.products;
  const warehouse = (movement as any)?.warehouses;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Movement Detail
        </span>
      }
      description="Stock movement information and traceability"
    >


        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : movement ? (
          <div className="space-y-4 mt-6">
            {/* Product — clickable */}
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Product</p>
              {product ? (
                <>
                  {onOpenProductDrawer ? (
                    <ClickableEntity onClick={() => onOpenProductDrawer(product.id)}>
                      {product.name}
                    </ClickableEntity>
                  ) : (
                    <p className="font-semibold">{product.name}</p>
                  )}
                  {product.sku && (
                    <p className="text-xs text-muted-foreground">SKU: {product.sku}</p>
                  )}
                </>
              ) : (
                <p className="font-semibold">—</p>
              )}
            </div>

            {/* Key fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border p-3 min-w-0">
                <p className="text-xs text-muted-foreground">Type</p>
                <Badge variant="outline" className="mt-1 capitalize max-w-full truncate">
                  {getMovementLabel(movement.movement_type)}
                </Badge>
              </div>
              <div className="rounded-lg border p-3 min-w-0">
                <p className="text-xs text-muted-foreground">Quantity</p>
                {(() => {
                  const pkg = (movement as any).source_packaging;
                  const uom = (movement as any).source_uom;
                  const baseLabel = uom?.code || uom?.name || "ea";
                  const absQty = Math.abs(movement.quantity);
                  const dq = pkg?.qty_in_base_uom && pkg.qty_in_base_uom > 0
                    ? absQty / pkg.qty_in_base_uom
                    : absQty;
                  const formatted = formatTransactionQty(dq, pkg?.name ?? null, absQty, baseLabel);
                  return (
                    <p className={`font-bold text-lg break-words ${movement.quantity >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {movement.quantity >= 0 ? <ArrowUp className="inline h-4 w-4 mr-1" /> : <ArrowDown className="inline h-4 w-4 mr-1" />}
                      {formatted}
                    </p>
                  );
                })()}
              </div>
              <div className="rounded-lg border p-3 min-w-0">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Calendar className="h-3 w-3 shrink-0" /> Date</p>
                <p className="font-medium break-words text-sm">{format(new Date(movement.movement_date), "MMM d, yyyy HH:mm")}</p>
              </div>
              {movement.unit_cost != null && (
                <div className="rounded-lg border p-3 min-w-0">
                  <p className="text-xs text-muted-foreground">Unit Cost</p>
                  <p className="font-medium break-words">{formatCurrency(movement.unit_cost)}</p>
                </div>
              )}

              {/* Warehouse — clickable */}
              {warehouse && (
                <div className="rounded-lg border p-3 min-w-0">
                  <p className="text-xs text-muted-foreground flex items-center gap-1"><Warehouse className="h-3 w-3 shrink-0" /> Warehouse</p>
                  {onOpenWarehouseDrawer ? (
                    <ClickableEntity onClick={() => onOpenWarehouseDrawer(warehouse.id, warehouse.name)}>
                      <span className="break-words">{warehouse.name}</span>
                    </ClickableEntity>
                  ) : (
                    <p className="font-medium break-words">{warehouse.name}</p>
                  )}
                </div>
              )}

              {movement.unit_cost != null && (
                <div className="rounded-lg border p-3 min-w-0">
                  <p className="text-xs text-muted-foreground">Total Value</p>
                  <p className="font-semibold break-words">{formatCurrency(Math.abs(movement.quantity) * movement.unit_cost)}</p>
                </div>
              )}
            </div>

            {/* Source Document — clickable badge */}
            {movement.reference_type && (
              <>
                <Separator />
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground mb-2">Source Document</p>
                  <SourceDocumentBadge
                    referenceType={movement.reference_type}
                    referenceId={movement.reference_id}
                    onOpenDrawer={onOpenSourceDocDrawer}
                  />
                </div>
              </>
            )}

            {/* Creator */}
            {creator && (
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><User className="h-3 w-3" /> Created By</p>
                <p className="font-medium">{creator.full_name || creator.email || "Unknown"}</p>
                <p className="text-xs text-muted-foreground">{format(new Date(movement.created_at), "MMM d, yyyy HH:mm:ss")}</p>
              </div>
            )}

            {/* Notes */}
            {movement.notes && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Notes</p>
                  <p className="text-sm">{movement.notes}</p>
                </div>
              </>
            )}

            {/* Related movements */}
            {relatedMovements.length > 0 && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-2">Related Movements</p>
                  <div className="space-y-2">
                    {relatedMovements.map((rm: any) => (
                      <div key={rm.id} className="flex items-center justify-between rounded border p-2 text-sm">
                        <div>
                          <span className="font-medium">{rm.products?.name || "—"}</span>
                          <span className="text-muted-foreground ml-2">{rm.warehouses?.name || ""}</span>
                        </div>
                        <span className={rm.quantity >= 0 ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
                          {rm.quantity >= 0 ? "+" : ""}{rm.quantity}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">Movement not found</p>
          </div>
      )}
    </DetailSheet>

  );
}
