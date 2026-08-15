import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCurrency } from "@/hooks/useCurrency";
import type { ProductDetailData } from "@/hooks/inventory/useProductDetailData";
import {
  formatQtyWithPacks,
  decomposeQty,
  type PackForRollup,
} from "@/lib/inventory/formatQty";
import { productBaseLabelOrUnset } from "@/lib/inventory/uom";

interface Props {
  data: ProductDetailData;
}

export function UnitsPackagingTab({ data }: Props) {
  const { formatCurrency } = useCurrency();
  const [convertInput, setConvertInput] = useState("");
  const p = data.product;
  if (!p) return null;

  const baseLabel = productBaseLabelOrUnset(p);
  const unitPrice = Number((p as any).unit_price ?? 0);
  const costPrice = Number(p.cost_price ?? 0);
  const onHand = (data.warehouseStock ?? []).reduce(
    (s: number, ws: any) => s + (Number(ws.quantity) || 0),
    0,
  );
  const packs: PackForRollup[] = (data.packaging ?? []).map((pk: any) => ({
    name: pk.name,
    qty_in_base_uom: Number(pk.qty_in_base_uom),
  }));

  // barcodes grouped by packaging_id (null = base)
  const barcodesByPack = new Map<string | null, string[]>();
  for (const id of data.identifiers) {
    const k = (id as any).packaging_id ?? null;
    const list = barcodesByPack.get(k) ?? [];
    if ((id as any).code) list.push((id as any).code);
    barcodesByPack.set(k, list);
  }
  const baseBarcodes = barcodesByPack.get(null) ?? [];

  const convertQty = Number(convertInput);
  const convertDecomp =
    Number.isFinite(convertQty) && convertQty > 0
      ? decomposeQty(convertQty, packs, baseLabel)
      : null;

  return (
    <div className="space-y-4 pt-2">
      <div className="rounded-md border p-3 text-sm space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Base unit</span>
          <span className="font-medium">{baseLabel}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Base price / cost</span>
          <span className="font-medium">
            {formatCurrency(unitPrice)}
            {costPrice > 0 && (
              <span className="text-muted-foreground"> · cost {formatCurrency(costPrice)}</span>
            )}
          </span>
        </div>
        {baseBarcodes.length > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Barcodes (base)</span>
            <span className="font-mono text-xs">{baseBarcodes.join(", ")}</span>
          </div>
        )}
        {packs.length > 0 && onHand > 0 && (
          <div className="flex justify-between border-t pt-1 mt-1">
            <span className="text-muted-foreground">Current on-hand</span>
            <span className="font-medium">{formatQtyWithPacks(onHand, packs, baseLabel)}</span>
          </div>
        )}
      </div>

      {data.packaging.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pack</TableHead>
              <TableHead className="text-right">Contains</TableHead>
              <TableHead className="text-right">Sell / pack</TableHead>
              <TableHead className="text-right">Cost / pack</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Barcodes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.packaging.map((pk: any) => {
              const codes = barcodesByPack.get(pk.id) ?? [];
              const qib = Number(pk.qty_in_base_uom);
              return (
                <TableRow key={pk.id}>
                  <TableCell className="font-medium">{pk.name}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {qib} {baseLabel}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {unitPrice > 0 ? formatCurrency(unitPrice * qib) : "—"}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap text-muted-foreground">
                    {costPrice > 0 ? formatCurrency(costPrice * qib) : "—"}
                  </TableCell>
                  <TableCell className="space-x-1">
                    {pk.is_sales_default && <Badge variant="secondary" className="text-xs">Sales</Badge>}
                    {pk.is_purchase_default && <Badge variant="secondary" className="text-xs">Purchase</Badge>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {codes.length > 0 ? codes.join(", ") : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">
          Single-unit product — no packs defined.
        </p>
      )}

      {/* Converter */}
      {packs.length > 0 && (
        <div className="rounded-md border p-3 space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Convert quantity
          </h4>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min="0"
              step="any"
              placeholder={`Enter a quantity in ${baseLabel}`}
              value={convertInput}
              onChange={(e) => setConvertInput(e.target.value)}
              className="max-w-[200px]"
            />
            <span className="text-xs text-muted-foreground">{baseLabel}</span>
          </div>
          {convertDecomp && (
            <p className="text-sm">
              ={" "}
              {convertDecomp
                .filter((d) => d.count > 0)
                .map((d, i, arr) => (
                  <span key={d.name}>
                    <span className="font-medium">{d.count} {d.name}</span>
                    {i < arr.length - 1 ? " + " : ""}
                  </span>
                ))}
              {convertDecomp.every((d) => d.count === 0) && (
                <span className="text-muted-foreground">0 {baseLabel}</span>
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Sales and purchases store the quantity in base units. Packs are a
            presentation layer derived from the table above.
          </p>
        </div>
      )}
    </div>
  );
}
