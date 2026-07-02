// `po_three_way_match` is a SECURITY INVOKER view defined in supabase/migrations
// and present in src/integrations/supabase/types.ts. It is queried as a regular table.
/**
 * BillVsReceiptDiffPanel — Odoo-style 3-way match surface.
 *
 * For each line of a purchase order, shows:
 *   Ordered  vs  Received  vs  Billed   →  qty to receive / qty to bill
 *
 * This is the central control that turns the Purchases module from a
 * "data warehouse" into an AP-grade control surface (the entire reason
 * `purchase_order_items.quantity_billed` was added to the schema).
 *
 * Reads from the SECURITY INVOKER view `public.po_three_way_match`, so
 * org/business RLS on `purchase_orders` is enforced for the caller.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Scale } from "lucide-react";

interface ThreeWayRow {
  po_item_id: string;
  description: string | null;
  qty_ordered: number;
  qty_received: number;
  qty_billed: number;
  qty_to_receive: number;
  qty_to_bill: number;
  qty_received_not_billed: number;
  sort_order: number;
}

interface Props {
  purchaseOrderId: string;
}

export function BillVsReceiptDiffPanel({ purchaseOrderId }: Props) {
  const [rows, setRows] = useState<ThreeWayRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      const { data, error } = await (supabase as any)
        .from("po_three_way_match")
        .select(
          "po_item_id, description, qty_ordered, qty_received, qty_billed, qty_to_receive, qty_to_bill, qty_received_not_billed, sort_order"
        )
        .eq("purchase_order_id", purchaseOrderId)
        .order("sort_order", { ascending: true });

      if (cancelled) return;
      if (error) {
        console.error("BillVsReceiptDiff load failed:", error);
        setRows([]);
      } else {
        setRows((data || []) as ThreeWayRow[]);
      }
      setIsLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [purchaseOrderId]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading match…
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No line items.</p>;
  }

  // Roll-ups for the summary row
  const totals = rows.reduce(
    (acc, r) => ({
      ordered: acc.ordered + Number(r.qty_ordered || 0),
      received: acc.received + Number(r.qty_received || 0),
      billed: acc.billed + Number(r.qty_billed || 0),
      toReceive: acc.toReceive + Number(r.qty_to_receive || 0),
      toBill: acc.toBill + Number(r.qty_to_bill || 0),
      gap: acc.gap + Number(r.qty_received_not_billed || 0),
    }),
    { ordered: 0, received: 0, billed: 0, toReceive: 0, toBill: 0, gap: 0 }
  );

  const matchBadge = () => {
    if (totals.toReceive === 0 && totals.toBill === 0) {
      return <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-600">Fully matched</Badge>;
    }
    if (totals.gap > 0) {
      return <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">Received but not billed</Badge>;
    }
    if (totals.toReceive > 0) {
      return <Badge variant="outline">Awaiting receipt</Badge>;
    }
    return <Badge variant="outline">In progress</Badge>;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium flex items-center gap-2">
          <Scale className="h-4 w-4" />
          Bill vs Receipt Match
        </h4>
        {matchBadge()}
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="text-xs">Description</TableHead>
              <TableHead className="text-xs text-right">Ordered</TableHead>
              <TableHead className="text-xs text-right">Received</TableHead>
              <TableHead className="text-xs text-right">Billed</TableHead>
              <TableHead className="text-xs text-right">To Receive</TableHead>
              <TableHead className="text-xs text-right">To Bill</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const ordered = Number(r.qty_ordered || 0);
              const received = Number(r.qty_received || 0);
              const billed = Number(r.qty_billed || 0);
              const toReceive = Number(r.qty_to_receive || 0);
              const toBill = Number(r.qty_to_bill || 0);
              return (
                <TableRow key={r.po_item_id}>
                  <TableCell className="text-sm">{r.description || "—"}</TableCell>
                  <TableCell className="text-sm text-right tabular-nums">{ordered}</TableCell>
                  <TableCell className="text-sm text-right tabular-nums">
                    <span className={received >= ordered ? "text-emerald-600" : received > 0 ? "text-amber-600" : "text-muted-foreground"}>
                      {received}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-right tabular-nums">
                    <span className={billed >= ordered ? "text-emerald-600" : billed > 0 ? "text-amber-600" : "text-muted-foreground"}>
                      {billed}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-right tabular-nums">
                    {toReceive > 0 ? <span className="text-amber-600">{toReceive}</span> : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-right tabular-nums">
                    {toBill > 0 ? <span className="text-amber-600">{toBill}</span> : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow className="bg-muted/40 font-medium">
              <TableCell className="text-xs uppercase text-muted-foreground">Totals</TableCell>
              <TableCell className="text-sm text-right tabular-nums">{totals.ordered}</TableCell>
              <TableCell className="text-sm text-right tabular-nums">{totals.received}</TableCell>
              <TableCell className="text-sm text-right tabular-nums">{totals.billed}</TableCell>
              <TableCell className="text-sm text-right tabular-nums">{totals.toReceive || "—"}</TableCell>
              <TableCell className="text-sm text-right tabular-nums">{totals.toBill || "—"}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export default BillVsReceiptDiffPanel;
