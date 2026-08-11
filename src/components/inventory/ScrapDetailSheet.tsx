/**
 * Scrap document peek sheet — drill-down from the scrap log. Shows the
 * header, lines with cost, linked journal entry, movement trail, audit
 * metadata and, when posted, an SoD-guarded reversal action.
 */
import { useMemo } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/design-system";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { Trash2, RotateCcw, ExternalLink, ShieldAlert } from "lucide-react";
import { scrapReasonLabel } from "@/pages/inventory/scrapReasons";
import { useNavigate } from "react-router-dom";
import { useReverseScrap } from "@/hooks/useScrap";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scrapId: string | null;
}

function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "approved":
    case "posted":
      return "default";
    case "draft":
    case "pending_approval":
      return "secondary";
    case "rejected":
    case "reversed":
      return "destructive";
    default:
      return "outline";
  }
}

export function ScrapDetailSheet({ open, onOpenChange, scrapId }: Props) {
  const navigate = useNavigate();
  const reverseScrap = useReverseScrap();

  const { data, isLoading } = useQuery({
    queryKey: ["scrap-detail", scrapId],
    enabled: open && !!scrapId,
    queryFn: async () => {
      if (!scrapId) return null;
      const { data: header, error } = (await (supabase as any)
        .from("stock_adjustments")
        .select(
          `id, adjustment_number, adjustment_date, reason, notes, status,
           approved_by, approved_at, created_by, created_at, warehouse_id, branch_id,
           warehouses:warehouse_id ( id, name ),
           stock_adjustment_items (
             id, product_id, quantity_adjustment, unit_cost, lot_id, notes,
             products:product_id ( id, name, sku )
           ),
           journal_entries!journal_entries_source_id_fkey (
             id, entry_number, entry_date, total_debit, total_credit, status
           )`,
        )
        .eq("id", scrapId)
        .maybeSingle()) as { data: any; error: any };
      if (error) throw error;

      const { data: movements } = await supabase
        .from("stock_movements")
        .select("id, movement_type, quantity, unit_cost, movement_date, notes")
        .eq("reference_id", scrapId)
        .order("movement_date", { ascending: false });

      return { header, movements: movements ?? [] };
    },
  });

  const header = data?.header as any;
  const items = (header?.stock_adjustment_items ?? []) as any[];
  const je = (header?.journal_entries ?? [])[0];

  const totalValue = useMemo(
    () =>
      items.reduce(
        (s, it) =>
          s + Math.abs(Number(it.quantity_adjustment) || 0) * Number(it.unit_cost || 0),
        0,
      ),
    [items],
  );
  const totalQty = useMemo(
    () => items.reduce((s, it) => s + Math.abs(Number(it.quantity_adjustment) || 0), 0),
    [items],
  );

  const fmt = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleReverse = async () => {
    if (!scrapId || !header) return;
    const reason = window.prompt("Reversal reason (audit trail):");
    if (!reason || !reason.trim()) return;
    await reverseScrap.mutateAsync({ scrapId, reason: reason.trim() });
  };

  const canReverse =
    header?.status === "posted" || header?.status === "approved";
  const selfActionRisk =
    header?.created_by && header?.approved_by && header.created_by === header.approved_by;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <Trash2 className="h-5 w-5" />
          {header?.adjustment_number ?? "Scrap document"}
        </span>
      }
      description="Scrap / waste — inventory adjustment"
    >
      {isLoading || !header ? (
        <div className="py-8">
          <LoadingState />
        </div>
      ) : (
        <div className="space-y-5 mt-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Status</p>
              <Badge variant={statusTone(header.status)} className="mt-1 capitalize">
                {header.status.replace(/_/g, " ")}
              </Badge>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Date</p>
              <p className="font-semibold">
                {format(new Date(header.adjustment_date), "MMM d, yyyy")}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Reason</p>
              <p className="font-semibold">{scrapReasonLabel(header.reason)}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Warehouse</p>
              <p className="font-semibold">{header.warehouses?.name ?? "—"}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Total quantity</p>
              <p className="font-semibold text-destructive">{fmt(totalQty)}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Financial impact</p>
              <p className="font-semibold text-destructive">{fmt(totalValue)}</p>
            </div>
          </div>

          {selfActionRisk && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 mt-0.5 text-destructive" />
              <span>
                Segregation-of-duties: this scrap was created and approved by the
                same user. Governance may flag this event.
              </span>
            </div>
          )}

          {header.notes && (
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground mb-1">Notes</p>
              <p className="text-sm whitespace-pre-wrap">{header.notes}</p>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-sm">Lines ({items.length})</h3>
            </div>
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit cost</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell>
                        <div className="font-medium">
                          {it.products?.name ?? "Product"}
                        </div>
                        {it.products?.sku && (
                          <div className="text-xs text-muted-foreground font-mono">
                            {it.products.sku}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-destructive">
                        {fmt(Math.abs(Number(it.quantity_adjustment) || 0))}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmt(Number(it.unit_cost || 0))}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {fmt(
                          Math.abs(Number(it.quantity_adjustment) || 0) *
                            Number(it.unit_cost || 0),
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Journal entry</p>
              {je ? (
                <button
                  className="mt-1 text-primary hover:underline flex items-center gap-1 text-sm"
                  onClick={() => navigate(`/finance-app/journal-entries?id=${je.id}`)}
                >
                  {je.entry_number ?? je.id.slice(0, 8)}
                  <ExternalLink className="h-3 w-3" />
                </button>
              ) : (
                <p className="text-sm text-muted-foreground">Not posted</p>
              )}
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Movements</p>
              <p className="font-semibold">{data?.movements.length ?? 0}</p>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <div className="text-xs text-muted-foreground">
              Created {format(new Date(header.created_at), "MMM d, yyyy p")}
              {header.approved_at && (
                <> · Approved {format(new Date(header.approved_at), "MMM d, yyyy p")}</>
              )}
            </div>
            {canReverse && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleReverse}
                disabled={reverseScrap.isPending}
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                {reverseScrap.isPending ? "Reversing…" : "Reverse scrap"}
              </Button>
            )}
          </div>
        </div>
      )}
    </DetailSheet>
  );
}
