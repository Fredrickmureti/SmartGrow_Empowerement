import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format, differenceInDays } from "date-fns";
import { AlertTriangle } from "lucide-react";
import type { ProductDetailData } from "@/hooks/inventory/useProductDetailData";

interface Props {
  data: ProductDetailData;
}

export function LotsExpiryTab({ data }: Props) {
  const p = data.product;
  const alertDays: number = p?.expiry_alert_days ?? 30;
  const lots = data.warehouseStockLots;

  if (lots.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No active lots for this product in the current branch.
      </div>
    );
  }

  const expiringSoon = lots.filter((l: any) => {
    if (!l.expiry_date) return false;
    const d = differenceInDays(new Date(l.expiry_date), new Date());
    return d >= 0 && d <= alertDays;
  });

  return (
    <div className="space-y-3 pt-2">
      {expiringSoon.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-warning" />
          <span>
            {expiringSoon.length} lot{expiringSoon.length === 1 ? "" : "s"} expiring within{" "}
            {alertDays} days. FEFO will allocate these first.
          </span>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Lot / serial</TableHead>
            <TableHead>Warehouse</TableHead>
            <TableHead>Expiry</TableHead>
            <TableHead className="text-right">Qty</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lots.map((l: any) => {
            const days = l.expiry_date
              ? differenceInDays(new Date(l.expiry_date), new Date())
              : null;
            const tone =
              days === null
                ? null
                : days < 0
                  ? "destructive"
                  : days <= alertDays
                    ? "warning"
                    : "ok";
            return (
              <TableRow key={l.id}>
                <TableCell className="font-mono text-xs">{l.lot_number ?? "—"}</TableCell>
                <TableCell className="text-sm">{l.warehouses?.name ?? "—"}</TableCell>
                <TableCell>
                  {l.expiry_date ? (
                    <Badge
                      variant={tone === "destructive" ? "destructive" : "outline"}
                      className={
                        tone === "warning"
                          ? "border-warning/40 text-warning"
                          : tone === "ok"
                            ? ""
                            : ""
                      }
                    >
                      {format(new Date(l.expiry_date), "MMM d, yyyy")}
                      {days !== null && days >= 0 && (
                        <span className="ml-1 opacity-70">· {days}d</span>
                      )}
                      {days !== null && days < 0 && (
                        <span className="ml-1 opacity-70">· expired</span>
                      )}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-medium">{Number(l.quantity) || 0}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}