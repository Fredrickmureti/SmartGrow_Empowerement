/**
 * LotGenealogyDialog — drill-down for one row of the Lot Traceability report.
 *
 * Phase 7.4. Answers "where did this lot come from and where did it go"
 * without leaving the report:
 *
 *   - backward trace  = inbound movements (receipt, supplier, GRN reference)
 *   - forward trace   = outbound movements (issues, sales, transfers, scrap)
 *     with a running consumed quantity
 *
 * Data comes ONLY from `useLotGenealogy` → `trace_lot_genealogy`, which is the
 * same authoritative projection `/inventory-app/lots/:id` reads. The panel
 * states quantities and references; the lot's VALUE is echoed from the report
 * row (already produced by `_inventory_layer_valuation_as_of`), never
 * recomputed here. Serial-tracked products surface their serials on the same
 * movement rows — no parallel serial RPC.
 */
import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowDownRight, ArrowUpRight } from "lucide-react";
import { format } from "date-fns";
import { useLotGenealogy, lotReferenceLabel, type LotTimelineRow } from "@/hooks/inventory/useLotGenealogy";

export interface LotGenealogyTarget {
  businessId: string | null;
  productId: string | null;
  lotNumber: string | null;
  productName: string | null;
  sku: string | null;
  warehouseName: string | null;
  supplierName: string | null;
  receiptNumber: string | null;
  expiryDate: string | null;
  lotStatus: string | null;
  /** Echoed from the report row — never recomputed in this panel. */
  valueLabel: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: LotGenealogyTarget | null;
}

function MovementTable({
  rows,
  emptyMessage,
  runningLabel,
}: {
  rows: Array<LotTimelineRow & { running?: number }>;
  emptyMessage: string;
  runningLabel?: string;
}) {
  if (rows.length === 0) {
    return <div className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead>Warehouse</TableHead>
          <TableHead>Serial</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          {runningLabel && <TableHead className="text-right">{runningLabel}</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((m) => (
          <TableRow key={m.id}>
            <TableCell className="whitespace-nowrap text-xs">
              {format(new Date(m.movement_date), "dd MMM yyyy HH:mm")}
            </TableCell>
            <TableCell>
              <span className="flex items-center gap-1.5 text-xs">
                {m.direction === "in" ? (
                  <ArrowDownRight className="h-3.5 w-3.5 text-success" />
                ) : (
                  <ArrowUpRight className="h-3.5 w-3.5 text-warning" />
                )}
                {m.movement_type}
              </span>
            </TableCell>
            <TableCell className="text-xs">{lotReferenceLabel(m.reference_type)}</TableCell>
            <TableCell className="text-xs">{m.warehouse_name ?? "—"}</TableCell>
            <TableCell className="font-mono text-xs">{m.serial_number ?? "—"}</TableCell>
            <TableCell className="text-right font-mono text-xs">
              {Number(m.signed_quantity).toLocaleString()}
            </TableCell>
            {runningLabel && (
              <TableCell className="text-right font-mono text-xs">
                {Number(m.running ?? 0).toLocaleString()}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function LotGenealogyDialog({ open, onOpenChange, target }: Props) {
  const { data, isLoading, error } = useLotGenealogy({
    businessId: target?.businessId ?? null,
    productId: target?.productId ?? null,
    lotNumber: target?.lotNumber ?? null,
    enabled: open,
  });

  const { inbound, outbound } = useMemo(() => {
    const timeline = data?.timeline ?? [];
    const inRows = timeline.filter((m) => m.direction === "in");
    let consumed = 0;
    const outRows = timeline
      .filter((m) => m.direction === "out")
      .map((m) => {
        consumed += Math.abs(Number(m.signed_quantity ?? 0));
        return { ...m, running: consumed };
      });
    return { inbound: inRows, outbound: outRows };
  }, [data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono">{target?.lotNumber ?? "Lot"}</DialogTitle>
          <DialogDescription>
            {target?.productName ?? "—"}
            {target?.sku ? ` · ${target.sku}` : ""}
            {target?.warehouseName ? ` · ${target.warehouseName}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">Supplier</div>
            <div>{target?.supplierName || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Receipt</div>
            <div className="font-mono text-xs">{target?.receiptNumber || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Expiry</div>
            <div>
              {target?.expiryDate
                ? format(new Date(target.expiryDate), "dd MMM yyyy")
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Value (as at report date)</div>
            <div className="font-mono">{target?.valueLabel ?? "—"}</div>
          </div>
        </div>

        {target?.lotStatus && (
          <div>
            <Badge variant={target.lotStatus === "active" ? "secondary" : "outline"}>
              {target.lotStatus}
            </Badge>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-destructive">
            {(error as Error).message}
          </div>
        ) : (
          <div className="space-y-6">
            <section>
              <h4 className="mb-2 text-sm font-medium">Backward trace — origin</h4>
              <MovementTable rows={inbound} emptyMessage="No inbound movements for this lot." />
            </section>
            <section>
              <h4 className="mb-2 text-sm font-medium">Forward trace — where it went</h4>
              <MovementTable
                rows={outbound}
                emptyMessage="Nothing issued from this lot yet."
                runningLabel="Cumulative consumed"
              />
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default LotGenealogyDialog;
