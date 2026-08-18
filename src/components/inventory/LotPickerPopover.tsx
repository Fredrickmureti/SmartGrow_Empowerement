/**
 * LotPickerPopover — Phase 3b UI primitive for FEFO-suggested lot picking.
 *
 * Shows the system-suggested first-expiring-first-out allocation as a
 * compact chip; opens a popover listing available alternative lots so the
 * operator can override. An override is reported back to the parent via
 * `onChange` with `allocation_override: true`, which downstream consumers
 * stamp onto the resulting stock movement for audit.
 *
 * Pure presentation — does no writes. The caller assembles the allocation
 * payload and submits it via `consume_lots_atomic` (or an atomic RPC that
 * wraps it) on confirmation.
 */
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronDown, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFefoSuggestion, type FefoAllocation } from "@/hooks/inventory/useFefoSuggestion";

export interface LotAllocationPayload {
  lot_number: string;
  serial_number: string | null;
  qty: number;
  allocation_override: boolean;
  expiry_date: string | null;
}

interface Props {
  businessId: string | null | undefined;
  warehouseId: string | null | undefined;
  productId: string | null | undefined;
  /** Required quantity expressed in **base units** (after pack normalization). */
  requiredQty: number;
  /** Called whenever the effective allocation changes (suggestion or override). */
  onChange?: (allocations: LotAllocationPayload[]) => void;
  /** Disable the picker entirely (e.g. when the product is not lot-tracked). */
  disabled?: boolean;
  /**
   * Optional pack context. When supplied the picker shows the pack name and
   * the pack-equivalent qty alongside the base-unit allocation. The picker
   * itself still operates in base units — packs are display-only here so
   * the FEFO/lot ledger stays unambiguous.
   */
  packLabel?: string | null;
  packMultiplier?: number | null;
  /**
   * Lot number captured from a GS1 scan (AI 10). When present, an
   * operator override allocation is emitted for this lot even if it is
   * not the FEFO suggestion. See ADR 0071.
   */
  scannedLot?: string | null;
  /**
   * Expiry date (ISO YYYY-MM-DD) captured from a GS1 scan (AI 17). Used
   * only for display alongside `scannedLot` — persistence still happens
   * via the goods-receipt path.
   */
  scannedExpiry?: string | null;
}

function toPayload(rows: FefoAllocation[], override: boolean): LotAllocationPayload[] {
  return rows.map((r) => ({
    lot_number: r.lot_number,
    serial_number: r.serial_number,
    qty: Number(r.qty),
    allocation_override: override,
    expiry_date: r.expiry_date,
  }));
}

export function LotPickerPopover({
  businessId,
  warehouseId,
  productId,
  requiredQty,
  onChange,
  disabled,
  packLabel,
  packMultiplier,
  scannedLot = null,
  scannedExpiry = null,
}: Props) {
  // The FEFO query cannot run without a business + warehouse context. When
  // either is missing the picker must say so — reporting "no lots available"
  // for a question we never asked reads as an inventory problem.
  const missingContext = !businessId || !warehouseId;

  const { data, isLoading, isError, error } = useFefoSuggestion({
    businessId,
    warehouseId,
    productId,
    requiredQty,
    enabled: !disabled,
  });


  const [override, setOverride] = useState<FefoAllocation[] | null>(null);

  // Reset operator override whenever inputs change.
  useEffect(() => {
    setOverride(null);
  }, [businessId, warehouseId, productId, requiredQty]);

  // Phase H — when a scanned lot arrives, emit an override allocation
  // pinned to that lot. If the lot is already in the FEFO suggestion we
  // re-anchor to it; if not, we still produce a single-row override so
  // the caller can seed a `consume_lots_atomic` payload with the
  // scanned batch (the RPC will reject unknown lots).
  useEffect(() => {
    if (!scannedLot) return;
    const match = (data ?? []).find(
      (r) => r.lot_number.toLowerCase() === scannedLot.toLowerCase(),
    );
    if (match) {
      setOverride([{ ...match, qty: requiredQty }]);
    } else {
      setOverride([
        {
          lot_id: `scan:${scannedLot}`,
          lot_number: scannedLot,
          serial_number: null,
          qty: requiredQty,
          expiry_date: scannedExpiry ?? null,
        } as FefoAllocation,
      ]);
    }
  }, [scannedLot, scannedExpiry, data, requiredQty]);

  const suggestion = data ?? [];
  const effective = override ?? suggestion;

  // Notify parent of effective allocation (debounced via React's batching).
  useEffect(() => {
    if (disabled) return;
    onChange?.(toPayload(effective, override !== null));
    // onChange identity is the caller's concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective, override, disabled]);

  const packMult = packMultiplier && packMultiplier > 0 ? packMultiplier : null;
  const fmtPack = (baseQty: number) =>
    packMult ? `${(baseQty / packMult).toFixed(2)} × ${packLabel ?? "pack"}` : null;

  const primaryLabel = useMemo(() => {
    if (disabled) return "—";
    if (missingContext) return "Select a warehouse";
    if (isLoading) return "Picking lot…";
    if (isError) return "Lot lookup failed";
    if (effective.length === 0) return "No stock";
    const first = effective[0];
    const exp = first.expiry_date ? ` · exp ${first.expiry_date}` : "";
    const tag = override !== null ? " · override" : " · FEFO";
    const pack = packLabel ? ` · ${packLabel}` : "";
    return `Lot ${first.lot_number}${exp}${pack}${tag}`;
  }, [disabled, missingContext, isLoading, isError, effective, override, packLabel]);


  if (disabled) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Not lot-tracked
      </Badge>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={isLoading || isError}
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <CalendarDays className="h-3 w-3" />
          )}
          <span className="truncate max-w-[14rem]">{primaryLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[28rem] p-0">
        <div className="px-3 py-2 border-b">
          <div className="text-sm font-medium flex items-center gap-2">
            Lot allocation
            {packLabel && (
              <Badge variant="secondary" className="text-[10px]">
                {packLabel}
                {packMult ? ` · ×${packMult}` : ""}
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {override === null
              ? `System-suggested FEFO allocation for ${requiredQty} base units${
                  packMult ? ` (${fmtPack(requiredQty)})` : ""
                }.`
              : `Operator override active. Click a row to reassign.`}
          </div>
          {isError && (
            <div className="text-xs text-destructive mt-1">
              {String((error as Error)?.message ?? error)}
            </div>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Lot</TableHead>
              <TableHead className="text-xs">Expiry</TableHead>
              <TableHead className="text-xs text-right">
                Qty {packMult ? "(base · pack)" : ""}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {effective.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-xs text-muted-foreground">
                  {missingContext
                    ? "Select the warehouse this document issues stock from to see lots."
                    : "No lots available in this warehouse."}
                </TableCell>
              </TableRow>
            )}

            {effective.map((row) => (
              <TableRow key={row.lot_id}>
                <TableCell className="text-xs font-mono">{row.lot_number}</TableCell>
                <TableCell className="text-xs">{row.expiry_date ?? "—"}</TableCell>
                <TableCell className="text-xs text-right">
                  {row.qty}
                  {packMult && (
                    <span className="text-muted-foreground"> · {fmtPack(Number(row.qty))}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {override !== null && (
          <div className="px-3 py-2 border-t flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setOverride(null)}
            >
              Revert to FEFO
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
