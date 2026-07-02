/**
 * ExpiringLotsCard — Phase 8 dashboard widget.
 *
 * Reads `public.v_lots_expiring_soon` (security_invoker view; RLS flows
 * through the user's session) and surfaces lot batches with positive
 * on-hand stock that fall inside `products.expiry_alert_days` (default 30).
 *
 * Rendered on the Inventory Dashboard. No-op for businesses that haven't
 * turned on `is_expiry_tracked` on any product.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CalendarClock, Loader2 } from "lucide-react";

type ExpiringLotRow = {
  organization_id: string;
  business_id: string;
  warehouse_id: string;
  warehouse_name: string | null;
  product_id: string;
  product_name: string | null;
  product_sku: string | null;
  lot_id: string;
  lot_number: string | null;
  serial_number: string | null;
  expiry_date: string;
  days_to_expiry: number;
  alert_window_days: number;
  quantity_on_hand: number;
};

export function ExpiringLotsCard() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;
  const enabled = !!orgId && !!bizId;

  const { data = [], isLoading } = useQuery({
    queryKey: ["expiring-lots", orgId, bizId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        // View is not in the generated types — cast through any to keep
        // the call typed at the row shape we read.
        .from("v_lots_expiring_soon" as any)
        .select(
          "warehouse_id, warehouse_name, product_id, product_name, product_sku, lot_id, lot_number, serial_number, expiry_date, days_to_expiry, alert_window_days, quantity_on_hand",
        )
        .eq("organization_id", orgId!)
        .eq("business_id", bizId!)
        .order("days_to_expiry", { ascending: true })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as ExpiringLotRow[];
    },
    staleTime: 60_000,
  });

  const { expired, soon } = useMemo(() => {
    const expired = data.filter((r) => r.days_to_expiry < 0).length;
    const soon = data.length - expired;
    return { expired, soon };
  }, [data]);

  if (!enabled) return null;
  if (!isLoading && data.length === 0) return null;

  return (
    <Card className="border-amber-500/40">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-5 w-5 text-amber-600" />
          Lots expiring soon
          {expired > 0 && (
            <Badge variant="destructive" className="ml-1">{expired} expired</Badge>
          )}
          {soon > 0 && (
            <Badge variant="outline" className="border-amber-500 text-amber-700">
              {soon} within window
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Lot batches with on-hand stock that fall inside their per-product
          alert window. Configure the window on each product (default 30 days).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking lots…
          </div>
        ) : (
          <ul className="divide-y">
            {data.slice(0, 10).map((row) => {
              const dayLabel =
                row.days_to_expiry < 0
                  ? `Expired ${Math.abs(row.days_to_expiry)}d ago`
                  : row.days_to_expiry === 0
                    ? "Expires today"
                    : `${row.days_to_expiry}d left`;
              const dayTone =
                row.days_to_expiry < 0
                  ? "text-destructive"
                  : row.days_to_expiry <= 7
                    ? "text-amber-700"
                    : "text-muted-foreground";
              return (
                <li
                  key={`${row.warehouse_id}-${row.lot_id}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {row.product_name ?? "Product"}{" "}
                      <span className="font-mono text-xs text-muted-foreground">
                        {row.lot_number ?? row.serial_number ?? row.lot_id.slice(0, 8)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {row.warehouse_name ?? "Warehouse"} · {row.quantity_on_hand} on hand · exp {row.expiry_date}
                    </div>
                  </div>
                  <Badge variant="outline" className={dayTone}>
                    {dayLabel}
                  </Badge>
                </li>
              );
            })}
            {data.length > 10 && (
              <li className="pt-2 text-xs text-muted-foreground">
                +{data.length - 10} more lots within alert window
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default ExpiringLotsCard;
