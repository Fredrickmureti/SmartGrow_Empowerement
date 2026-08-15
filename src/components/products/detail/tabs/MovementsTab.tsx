import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ArrowUp, ArrowDown, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import type { ProductDetailData } from "@/hooks/inventory/useProductDetailData";
import { formatBaseQtyAsPacks, type PackForRollup } from "@/lib/packagingRollup";
import { SourceDocumentBadge } from "@/components/inventory/SourceDocumentBadge";
import { productBaseLabelOrUnset } from "@/lib/inventory/uom";

interface Props {
  data: ProductDetailData;
}

export function MovementsTab({ data }: Props) {
  const baseLabel = productBaseLabelOrUnset(data.product);
  const packs: PackForRollup[] = (data.packaging ?? []).map((p: any) => ({
    name: p.name,
    qty_in_base_uom: Number(p.qty_in_base_uom),
  }));
  const fmtSigned = (qty: number) => {
    const abs = Math.abs(qty);
    const base = `${Number(abs.toFixed(3))} ${baseLabel}`;
    if (packs.length === 0 || abs <= 0) return base;
    const pack = formatBaseQtyAsPacks(abs, packs, baseLabel);
    return pack === base ? base : `${pack} (${base})`;
  };

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [since, setSince] = useState<string>("");

  const types = useMemo(() => {
    const s = new Set<string>();
    for (const m of data.recentMovements) s.add(String(m.movement_type));
    return Array.from(s).sort();
  }, [data.recentMovements]);

  const warehouses = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of data.recentMovements as any[]) {
      if (m.warehouse_id) map.set(m.warehouse_id, m.warehouses?.name ?? "—");
    }
    return Array.from(map.entries());
  }, [data.recentMovements]);

  const filtered = useMemo(() => {
    const sinceTs = since ? new Date(since).getTime() : null;
    return (data.recentMovements as any[]).filter((m) => {
      if (typeFilter !== "all" && String(m.movement_type) !== typeFilter) return false;
      if (warehouseFilter !== "all" && m.warehouse_id !== warehouseFilter) return false;
      if (sinceTs && new Date(m.movement_date).getTime() < sinceTs) return false;
      return true;
    });
  }, [data.recentMovements, typeFilter, warehouseFilter, since]);

  if (data.recentMovements.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No movements recorded yet.
      </div>
    );
  }
  const productId = (data.product as any)?.id;
  return (
    <div className="space-y-3 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {types.map((t) => (
              <SelectItem key={t} value={t} className="capitalize">{t.replace(/_/g, " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
          <SelectTrigger className="h-8 w-[170px] text-xs"><SelectValue placeholder="Warehouse" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All warehouses</SelectItem>
            {warehouses.map(([id, name]) => (
              <SelectItem key={id} value={id}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="h-8 w-[150px] text-xs"
          aria-label="From date"
        />
        {(typeFilter !== "all" || warehouseFilter !== "all" || since) && (
          <button
            className="text-xs text-muted-foreground underline"
            onClick={() => { setTypeFilter("all"); setWarehouseFilter("all"); setSince(""); }}
          >
            Clear
          </button>
        )}
        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length} of {data.recentMovements.length}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Warehouse</TableHead>
            <TableHead className="text-right">Qty</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((m: any) => {
            const qty = Number(m.quantity) || 0;
            return (
              <TableRow key={m.id}>
                <TableCell className="text-xs">{format(new Date(m.movement_date), "MMM d, yyyy")}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs capitalize">
                    {String(m.movement_type).replace(/_/g, " ")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <SourceDocumentBadge referenceType={m.reference_type} referenceId={m.reference_id} />
                </TableCell>
                <TableCell className="text-sm">{m.warehouses?.name ?? "—"}</TableCell>
                <TableCell className="text-right text-sm whitespace-nowrap">
                  <span className={qty >= 0 ? "text-success" : "text-destructive"}>
                    {qty >= 0 ? <ArrowUp className="inline h-3 w-3" /> : <ArrowDown className="inline h-3 w-3" />}
                    {fmtSigned(qty)}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-6">
                No movements match these filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {productId && (
        <div className="flex justify-end">
          <Link
            to={`/inventory-app/stock?product=${productId}`}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Open full movement history <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </div>
  );
}
