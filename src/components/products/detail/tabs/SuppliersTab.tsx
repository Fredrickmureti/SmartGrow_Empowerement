/**
 * SuppliersTab — preferred vendor + recent received purchase orders for a
 * single product. Read-only summary so a purchasing officer can act from the
 * product panel. Mounted by ProductDetailPanel when the product is stock-tracked.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format, differenceInDays } from "date-fns";
import { ShoppingCart, Loader2, Truck } from "lucide-react";
import {
  formatQtyWithPacks,
  type PackForRollup,
} from "@/lib/inventory/formatQty";

interface Props {
  productId: string;
  baseLabel: string;
  packs: PackForRollup[];
}

interface PORow {
  poId: string;
  poNumber: string | null;
  vendorId: string | null;
  vendorName: string | null;
  orderedDate: string | null;
  expectedDate: string | null;
  qty: number;
  unitCost: number;
  status: string;
}

export function SuppliersTab({ productId, baseLabel, packs }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();

  const { data, isLoading } = useQuery({
    queryKey: ["product-suppliers", productId, currentOrg?.id, currentBusiness?.id],
    enabled: !!productId && !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 60_000,
    queryFn: async (): Promise<{ rows: PORow[]; preferred: PORow | null }> => {
      const { data: lines, error } = await supabase
        .from("purchase_order_items")
        .select(
          "quantity, quantity_received, unit_price, purchase_orders!inner(id, po_number, status, order_date, expected_date, business_id, vendor_id, contacts:vendor_id(id, name))",
        )
        .eq("product_id", productId)
        .eq("purchase_orders.business_id", currentBusiness!.id)
        .order("order_date", { foreignTable: "purchase_orders", ascending: false })
        .limit(20);
      if (error) throw error;

      const rows: PORow[] = ((lines ?? []) as any[]).map((l) => ({
        poId: l.purchase_orders?.id ?? "",
        poNumber: l.purchase_orders?.po_number ?? null,
        vendorId: l.purchase_orders?.vendor_id ?? null,
        vendorName: l.purchase_orders?.contacts?.name ?? null,
        orderedDate: l.purchase_orders?.order_date ?? null,
        expectedDate: l.purchase_orders?.expected_date ?? null,
        qty: Number(l.quantity_received ?? l.quantity ?? 0),
        unitCost: Number(l.unit_price ?? 0),
        status: l.purchase_orders?.status ?? "draft",
      }));

      // Preferred vendor = most received qty in last 90 days
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const totals = new Map<string, { row: PORow; total: number }>();
      for (const r of rows) {
        if (!r.vendorId) continue;
        const ts = r.orderedDate ? new Date(r.orderedDate).getTime() : 0;
        if (ts < cutoff) continue;
        const cur = totals.get(r.vendorId);
        if (cur) cur.total += r.qty;
        else totals.set(r.vendorId, { row: r, total: r.qty });
      }
      const preferred = [...totals.values()].sort((a, b) => b.total - a.total)[0]?.row ?? null;
      return { rows: rows.slice(0, 5), preferred };
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data || data.rows.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No purchase orders recorded for this product yet.
      </div>
    );
  }

  const top = data.preferred;
  const fmt = (n: number) => formatQtyWithPacks(n, packs, baseLabel);

  return (
    <div className="space-y-4 pt-2">
      {top && (
        <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
          <div className="flex items-center gap-2">
            <Truck className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Preferred vendor</span>
            <Badge variant="secondary" className="text-xs">last 90 days</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-medium">{top.vendorName ?? "—"}</span>
            <Button size="sm" variant="outline" asChild>
              <Link to={`/purchases/orders/new?product=${productId}${top.vendorId ? `&contact_id=${top.vendorId}` : ""}`}>
                <ShoppingCart className="h-3.5 w-3.5 mr-1" /> New PO
              </Link>
            </Button>
          </div>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>PO</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Ordered</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Unit cost</TableHead>
            <TableHead className="text-right">Lead time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((r) => {
            const lead =
              r.orderedDate && r.expectedDate
                ? differenceInDays(new Date(r.expectedDate), new Date(r.orderedDate))
                : null;
            return (
              <TableRow key={r.poId}>
                <TableCell className="font-mono text-xs">
                  {r.poId ? (
                    <Link
                      to={`/purchases-app/purchase-orders?id=${r.poId}`}
                      className="text-primary hover:underline"
                    >
                      {r.poNumber ?? r.poId.slice(0, 8)}
                    </Link>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-sm">{r.vendorName ?? "—"}</TableCell>
                <TableCell className="text-xs">
                  {r.orderedDate ? format(new Date(r.orderedDate), "MMM d, yyyy") : "—"}
                </TableCell>
                <TableCell className="text-right text-sm whitespace-nowrap">{fmt(r.qty)}</TableCell>
                <TableCell className="text-right text-sm whitespace-nowrap">
                  {r.unitCost > 0 ? formatCurrency(r.unitCost) : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {lead != null ? `${lead}d` : <span className="text-muted-foreground">—</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
