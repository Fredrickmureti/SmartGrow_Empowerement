/**
 * StockMovementPeekSheet — the drawer projection of a stock movement.
 *
 * This used to be a hand-rolled `DetailSheet` with its own field grid. It is
 * now a `DocumentRecordView` descriptor (kind "stock_movement") projected
 * through `PeekScaffold`, like every other inventory peek.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ArrowUp, ArrowDown } from "lucide-react";

import { PeekScaffold } from "@/design-system/records";
import type { DocumentRecordView } from "@/design-system/records";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { SourceDocumentBadge } from "./SourceDocumentBadge";
import { formatTransactionQty } from "@/lib/inventory/formatQty";

interface StockMovementPeekSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  movementId: string | null;
  onOpenProductDrawer?: (productId: string) => void;
  onOpenWarehouseDrawer?: (warehouseId: string, warehouseName: string) => void;
  onOpenSourceDocDrawer?: (type: string, id: string) => void;
}

const MOVEMENT_LABELS: Record<string, string> = {
  purchase: "Purchase", receipt: "Receipt", sale: "Sale", pos_sale: "POS Sale",
  delivery: "Delivery", adjustment: "Adjustment", count: "Count", return_in: "Return In",
  pos_return: "POS Return", return_out: "Return Out", transfer: "Transfer",
  scrap: "Scrap", opening: "Opening",
};

const fmtDate = (v?: string | null, withTime = false) => {
  if (!v) return "—";
  try {
    return format(new Date(v), withTime ? "MMM d, yyyy HH:mm" : "PP");
  } catch {
    return v;
  }
};

export function StockMovementPeekSheet({
  open,
  onOpenChange,
  movementId,
  onOpenProductDrawer,
  onOpenWarehouseDrawer,
  onOpenSourceDocDrawer,
}: StockMovementPeekSheetProps) {
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

  const view = useMemo<DocumentRecordView>(() => {
    const product = (movement as any)?.products;
    const warehouse = (movement as any)?.warehouses;
    const pkg = (movement as any)?.source_packaging;
    const uom = (movement as any)?.source_uom;

    let quantityDisplay: React.ReactNode = "—";
    if (movement) {
      const baseLabel = uom?.code || uom?.name || "ea";
      const absQty = Math.abs(movement.quantity);
      const dq =
        pkg?.qty_in_base_uom && pkg.qty_in_base_uom > 0
          ? absQty / pkg.qty_in_base_uom
          : absQty;
      const formatted = formatTransactionQty(dq, pkg?.name ?? null, absQty, baseLabel);
      quantityDisplay = (
        <span
          className={`font-medium ${movement.quantity >= 0 ? "text-green-600" : "text-red-600"}`}
        >
          {movement.quantity >= 0 ? (
            <ArrowUp className="inline h-3.5 w-3.5 mr-1" />
          ) : (
            <ArrowDown className="inline h-3.5 w-3.5 mr-1" />
          )}
          {formatted}
        </span>
      );
    }

    const detailFields = movement
      ? [
          {
            label: "Product",
            value: product ? (
              onOpenProductDrawer ? (
                <ClickableEntity onClick={() => onOpenProductDrawer(product.id)}>
                  {product.name}
                </ClickableEntity>
              ) : (
                product.name
              )
            ) : (
              "—"
            ),
          },
          { label: "Type", value: MOVEMENT_LABELS[movement.movement_type] || movement.movement_type },
          { label: "Quantity", value: quantityDisplay },
          { label: "Date", value: fmtDate(movement.movement_date, true) },
          ...(movement.unit_cost != null
            ? [
                { label: "Unit cost", value: formatCurrency(movement.unit_cost) },
                {
                  label: "Total value",
                  value: formatCurrency(Math.abs(movement.quantity) * movement.unit_cost),
                },
              ]
            : []),
          {
            label: "Warehouse",
            value: warehouse ? (
              onOpenWarehouseDrawer ? (
                <ClickableEntity
                  onClick={() => onOpenWarehouseDrawer(warehouse.id, warehouse.name)}
                >
                  {warehouse.name}
                </ClickableEntity>
              ) : (
                warehouse.name
              )
            ) : (
              "—"
            ),
          },
          ...(movement.reference_type
            ? [
                {
                  label: "Source document",
                  value: (
                    <SourceDocumentBadge
                      referenceType={movement.reference_type}
                      referenceId={movement.reference_id}
                      onOpenDrawer={onOpenSourceDocDrawer}
                    />
                  ),
                },
              ]
            : []),
          {
            label: "Created by",
            value: creator
              ? `${creator.full_name || creator.email || "Unknown"} · ${fmtDate(movement.created_at, true)}`
              : "—",
          },
          { label: "Notes", value: movement.notes || "—" },
        ]
      : undefined;

    const extraSections =
      relatedMovements.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Related movements</p>
          <div className="space-y-2">
            {relatedMovements.map((rm: any) => (
              <div
                key={rm.id}
                className="flex items-center justify-between rounded border p-2 text-sm"
              >
                <div>
                  <span className="font-medium">{rm.products?.name || "—"}</span>
                  <span className="text-muted-foreground ml-2">
                    {rm.warehouses?.name || ""}
                  </span>
                </div>
                <span
                  className={
                    rm.quantity >= 0 ? "text-green-600 font-medium" : "text-red-600 font-medium"
                  }
                >
                  {rm.quantity >= 0 ? "+" : ""}
                  {rm.quantity}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : undefined;

    return {
      kind: "stock_movement",
      documentId: movement?.id,
      eyebrow: "Stock Movement",
      listPath: "/inventory-app/stock",
      title: "Movement Detail",
      docNumber: movement ? MOVEMENT_LABELS[movement.movement_type] || movement.movement_type : undefined,
      loading: isLoading,
      notFound: !isLoading && !!movementId && !movement,
      meta: movement ? <span>{fmtDate(movement.movement_date, true)}</span> : undefined,
      detailFields,
      extraSections,
    };
  }, [
    movement,
    movementId,
    isLoading,
    creator,
    relatedMovements,
    formatCurrency,
    onOpenProductDrawer,
    onOpenWarehouseDrawer,
    onOpenSourceDocDrawer,
  ]);

  return (
    <PeekScaffold
      {...view}
      open={open}
      onOpenChange={onOpenChange}
      fullPageHref={movementId ? `/inventory-app/stock?selected=${movementId}` : undefined}
    />
  );
}

export default StockMovementPeekSheet;
