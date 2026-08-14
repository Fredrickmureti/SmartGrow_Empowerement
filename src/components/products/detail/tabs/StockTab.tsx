import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import type { ProductDetailData } from "@/hooks/inventory/useProductDetailData";
import { formatBaseQtyAsPacks, type PackForRollup } from "@/lib/packagingRollup";

interface Props {
  data: ProductDetailData;
}

export function StockTab({ data }: Props) {
  const rules = new Map<string, any>();
  for (const r of data.reorderRules) rules.set(r.warehouse_id, r);

  const productId = (data.product as any)?.id as string | undefined;
  const businessId = (data.product as any)?.business_id as string | undefined;
  const warehouseIds: string[] = (data.warehouseStock ?? []).map(
    (ws: any) => ws.warehouse_id,
  );

  // ADR 0142 — per-warehouse availability is resolved by the server engine.
  // The browser never derives `quantity - reserved_quantity` itself.
  const { data: availabilityByWarehouse } = useQuery({
    queryKey: ["stock-availability-by-warehouse", productId, businessId, warehouseIds],
    enabled: !!productId && !!businessId && warehouseIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        warehouseIds.map(async (warehouseId) => [
          warehouseId,
          await resolveAvailability({
            productId: productId!,
            businessId: businessId!,
            warehouseId,
          }),
        ] as const),
      );
      return new Map(entries);
    },
  });

  const baseLabel = (data.product as any)?.unit_of_measure ?? "ea";
  const packs: PackForRollup[] = (data.packaging ?? []).map((p: any) => ({
    name: p.name,
    qty_in_base_uom: Number(p.qty_in_base_uom),
  }));
  const fmt = (n: number) => {
    if (!Number.isFinite(n)) return `0 ${baseLabel}`;
    const base = `${Number(n.toFixed(3))} ${baseLabel}`;
    if (packs.length === 0 || n <= 0) return base;
    const pack = formatBaseQtyAsPacks(n, packs, baseLabel);
    return pack === base ? base : `${pack} (${base})`;
  };


  if (data.warehouseStock.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No warehouse holds this product in the current branch.
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Warehouse</TableHead>
            <TableHead className="text-right">On hand</TableHead>
            <TableHead className="text-right">Reserved</TableHead>
            <TableHead className="text-right">Available</TableHead>
            <TableHead className="text-right">Reorder at</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.warehouseStock.map((ws: any) => {
            const a = availabilityByWarehouse?.get(ws.warehouse_id);
            const onHand = a?.onHand ?? 0;
            const reserved = a?.reserved ?? 0;
            const available = a?.available ?? 0;

            const rule = rules.get(ws.warehouse_id);
            const reorderAt = rule?.min_quantity ?? ws.reorder_level ?? null;
            const low = reorderAt != null && available <= Number(reorderAt);
            const reorderSource = rule?.min_quantity != null
              ? `Rule · ${ws.warehouses?.name ?? "warehouse"}`
              : ws.reorder_level != null
              ? "Warehouse default"
              : "Product default";
            return (
              <TableRow key={ws.id}>
                <TableCell className="font-medium">{ws.warehouses?.name ?? "—"}</TableCell>
                <TableCell className="text-right whitespace-nowrap">{fmt(onHand)}</TableCell>
                <TableCell className="text-right text-warning whitespace-nowrap">
                  {reserved > 0 ? (
                    <ReservedPopover
                      productId={(data.product as any)?.id}
                      businessId={(data.product as any)?.business_id}
                      warehouseId={ws.warehouse_id}
                      label={fmt(reserved)}
                      baseLabel={baseLabel}
                      fmt={fmt}
                    />
                  ) : "—"}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <span className={low ? "text-destructive font-semibold" : ""}>{fmt(available)}</span>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {reorderAt != null ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="underline decoration-dotted underline-offset-2 cursor-help">
                          {`${reorderAt} ${baseLabel}`}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{reorderSource}</TooltipContent>
                    </Tooltip>
                  ) : <span className="text-muted-foreground">—</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {data.incomingPo.totalQty > 0 && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <Badge variant="outline">Incoming</Badge>
          <span>
            {fmt(data.incomingPo.totalQty)} on {data.incomingPo.openOrders} open purchase
            {data.incomingPo.openOrders === 1 ? " order" : " orders"}
          </span>
        </div>
      )}
    </div>
  );
}

interface ReservedPopoverProps {
  productId?: string;
  businessId?: string;
  warehouseId: string;
  label: string;
  baseLabel: string;
  fmt: (n: number) => string;
}

/**
 * ReservedPopover — read-only drill into the origin of `warehouse_stock.reserved_quantity`.
 * Reads from `stock_reservations` (open: released_at IS NULL). POS holds now live
 * in the same table with `source_type='pos'` (ADR 0082 · T3), so the legacy
 * `pos_stock_reservations` query has been removed to avoid double-counting.
 */
function ReservedPopover({ productId, businessId, warehouseId, label, baseLabel, fmt }: ReservedPopoverProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["reserved-origins", productId, businessId, warehouseId],
    enabled: !!productId && !!businessId && !!warehouseId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data: openResv } = await supabase
        .from("stock_reservations")
        .select("id, quantity, source_type, source_id, expires_at, created_at")
        .eq("product_id", productId!)
        .eq("business_id", businessId!)
        .eq("warehouse_id", warehouseId)
        .is("released_at", null)
        .order("created_at", { ascending: false })
        .limit(10);
      return { resv: openResv ?? [], pos: [] as never[] };
    },
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="underline decoration-dotted underline-offset-2 text-warning hover:opacity-80">
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3 text-left" align="end">
        <div className="text-xs font-semibold mb-2">Open reservations</div>
        {isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : (data?.resv.length ?? 0) + (data?.pos.length ?? 0) === 0 ? (
          <div className="text-xs text-muted-foreground">
            Reserved quantity exists but no open reservation rows were found.
            This usually means the holds were released or expired but the
            aggregate hasn't been recomputed yet.
          </div>
        ) : (
          <ul className="space-y-1.5 text-xs max-h-56 overflow-auto">
            {(data?.pos ?? []).map((r: any) => (
              <li key={`pos-${r.id}`} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <Badge variant="outline" className="text-[10px] mr-1">POS</Badge>
                  <span className="truncate">{r.pos_registers?.name ?? "Register"}</span>
                  <div className="text-muted-foreground text-[10px]">
                    {r.created_at ? `held ${formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}` : ""}
                  </div>
                </div>
                <span className="whitespace-nowrap font-medium">{fmt(Number(r.quantity) || 0)}</span>
              </li>
            ))}
            {(data?.resv ?? []).map((r: any) => (
              <li key={`r-${r.id}`} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <Badge variant="outline" className="text-[10px] mr-1 capitalize">
                    {String(r.source_type ?? "hold").replace(/_/g, " ")}
                  </Badge>
                  <div className="text-muted-foreground text-[10px]">
                    {r.created_at ? `held ${formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}` : ""}
                    {r.expires_at ? ` · expires ${formatDistanceToNow(new Date(r.expires_at), { addSuffix: true })}` : ""}
                  </div>
                </div>
                <span className="whitespace-nowrap font-medium">{fmt(Number(r.quantity) || 0)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 text-[10px] text-muted-foreground">
          Showing up to 10 most recent per source. Total above is the canonical aggregate.
        </div>
      </PopoverContent>
    </Popover>
  );
}
