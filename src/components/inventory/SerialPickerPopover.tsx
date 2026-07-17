/**
 * SerialPickerPopover — Phase A.3 UI primitive for serial-tracked
 * products on outbound documents (invoice, credit note, sales return,
 * delivery note).
 *
 * Reads `stock_serials` where `product_id = ?`, `business_id = ?`,
 * `warehouse_id = ?`, `status = 'in_stock'` and lets the operator pick
 * up to `requiredQty` serial numbers. Pure presentation — no writes.
 * The caller assembles the outbound payload with the selected
 * `serial_ids` and posts via the existing atomic RPC surface (ADR 0067).
 *
 * Siblings: `LotPickerPopover` (FEFO lot allocation). One product may
 * be both lot- and serial-tracked; the two pickers coexist on the same
 * line row (see `OutboundLineTracking`).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Barcode, ChevronDown, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface SerialRow {
  id: string;
  serial_number: string;
  lot_number: string | null;
}

interface Props {
  businessId: string | null | undefined;
  warehouseId: string | null | undefined;
  productId: string | null | undefined;
  /** Number of units required — the picker limits selection to this count. */
  requiredQty: number;
  /** Selected serial ids controlled by the caller (or uncontrolled with initial). */
  value?: string[];
  onChange?: (serialIds: string[], rows: SerialRow[]) => void;
  disabled?: boolean;
  /** Serial ids to hide (already claimed by other lines in the same document). */
  excludeIds?: string[];
  /**
   * Serial number captured from a GS1 scan (AI 21). When present and the
   * matching in-stock row is found, it is auto-selected. See ADR 0071.
   */
  scannedSerial?: string | null;
}

export function SerialPickerPopover({
  businessId,
  warehouseId,
  productId,
  requiredQty,
  value,
  onChange,
  disabled,
  excludeIds = [],
  scannedSerial = null,
}: Props) {
  const enabled = !disabled && !!businessId && !!productId;
  const { data, isLoading, isError, error } = useQuery({
    queryKey: [
      "stock-serials-in-stock",
      businessId,
      warehouseId ?? null,
      productId,
    ],
    enabled,
    staleTime: 15_000,
    queryFn: async (): Promise<SerialRow[]> => {
      let q = supabase
        .from("stock_serials")
        .select("id, serial_number, lot_number")
        .eq("business_id", businessId!)
        .eq("product_id", productId!)
        .eq("status", "in_stock")
        .order("serial_number", { ascending: true })
        .limit(200);
      if (warehouseId) q = q.eq("current_warehouse_id", warehouseId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as SerialRow[];
    },
  });

  const [internal, setInternal] = useState<string[]>(value ?? []);
  useEffect(() => {
    if (value) setInternal(value);
  }, [value]);
  useEffect(() => {
    setInternal([]);
  }, [productId, warehouseId, businessId]);

  // Phase H — auto-select a scanned serial once its row is loaded.
  useEffect(() => {
    if (!scannedSerial || !data) return;
    const match = data.find(
      (r) => r.serial_number.toLowerCase() === scannedSerial.toLowerCase(),
    );
    if (!match) return;
    setInternal((prev) => {
      if (prev.includes(match.id)) return prev;
      if (prev.length >= Math.max(1, Math.floor(requiredQty))) return prev;
      const next = [...prev, match.id];
      const selectedRows = data.filter((r) => next.includes(r.id));
      onChange?.(next, selectedRows);
      return next;
    });
    // onChange identity managed by caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scannedSerial, data, requiredQty]);

  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const list = (data ?? []).filter((r) => !excludeIds.includes(r.id));
    if (!filter.trim()) return list;
    const needle = filter.trim().toLowerCase();
    return list.filter(
      (r) =>
        r.serial_number.toLowerCase().includes(needle) ||
        (r.lot_number ?? "").toLowerCase().includes(needle),
    );
  }, [data, excludeIds, filter]);

  const toggle = (id: string) => {
    setInternal((prev) => {
      const has = prev.includes(id);
      let next: string[];
      if (has) next = prev.filter((x) => x !== id);
      else if (prev.length >= Math.max(1, Math.floor(requiredQty))) return prev;
      else next = [...prev, id];
      const selectedRows = (data ?? []).filter((r) => next.includes(r.id));
      onChange?.(next, selectedRows);
      return next;
    });
  };

  if (disabled) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Not serial-tracked
      </Badge>
    );
  }

  const need = Math.max(1, Math.floor(requiredQty));
  const primaryLabel = isLoading
    ? "Loading serials…"
    : isError
      ? "Serial lookup failed"
      : internal.length === 0
        ? `Pick ${need} serial${need > 1 ? "s" : ""}`
        : `${internal.length} / ${need} selected`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={isLoading}
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Barcode className="h-3 w-3" />
          )}
          <span className="truncate max-w-[14rem]">{primaryLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[24rem] p-0">
        <div className="px-3 py-2 border-b space-y-2">
          <div className="text-sm font-medium">Serial numbers</div>
          <div className="text-xs text-muted-foreground">
            Pick {need} serial{need > 1 ? "s" : ""} for this line.
          </div>
          {isError && (
            <div className="text-xs text-destructive">
              {String((error as Error)?.message ?? error)}
            </div>
          )}
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by serial or lot"
            className="h-7 text-xs"
          />
        </div>
        <div className="max-h-64 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead className="text-xs">Serial</TableHead>
                <TableHead className="text-xs">Lot</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-xs text-muted-foreground">
                    No serials available.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((row) => {
                const checked = internal.includes(row.id);
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(row.id)}
                      />
                    </TableCell>
                    <TableCell className="text-xs font-mono">
                      {row.serial_number}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.lot_number ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </PopoverContent>
    </Popover>
  );
}
