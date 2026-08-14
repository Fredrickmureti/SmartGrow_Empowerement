/**
 * Mobile cycle count — scan bin + item, verify lot/serial/expiry where the
 * product demands it, enter counted qty, record.
 *
 * Both legs run on their resolver seams: `BinScanField`
 * (`resolve_location_identity`, ADR 0104) and `ProductScanField`
 * (`resolve_product_identity`, ADR-0017/0071). Neither leg string-compares.
 *
 * Lines are read through `get_count_lines`, never the table, so a blind
 * session really does hide the expected quantity from the counter.
 *
 * Superseded attempts (a line that has been recounted) are excluded from
 * matching and from the open/recount roll-ups — the same rule
 * `post_count_session` applies server-side.
 */
import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BinScanField } from "@/features/warehouse/locations/BinScanField";
import { ProductScanField } from "@/features/warehouse/scanning/ProductScanField";
import type { GatedScan } from "@/features/warehouse/scanning/useWmsIdentityGate";
import { useBusinesses } from "@/hooks/useBusinesses";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScanTextField } from "@/components/scanner/ScanTextField";
import { Label } from "@/components/ui/label";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProductPackagingBatch } from "@/hooks/inventory/useProductPackagingBatch";
import {
  unitOptionsFor,
  toBaseUnits,
  BASE_UNIT_KEY,
} from "@/features/warehouse/receiving/receivingUnits";
import { useCountLines, countLineProductLabel } from "@/features/warehouse/counts/useCountLines";
import {
  useProductTracking,
  serialCaptureError,
} from "@/features/warehouse/counts/useProductTracking";


export default function MobileCount() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const [binLocationId, setBinLocationId] = useState<string | null>(null);
  const [productScan, setProductScan] = useState<GatedScan | null>(null);
  const [countedQty, setCountedQty] = useState("");
  const [serialEntry, setSerialEntry] = useState("");
  const [serials, setSerials] = useState<string[]>([]);
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const { data: lines } = useCountLines(id);
  const blind = (lines ?? []).some((l) => l.is_blind);

  const supersededIds = useMemo(
    () => new Set((lines ?? []).map((l) => l.recount_of_line_id).filter(Boolean) as string[]),
    [lines],
  );
  const latest = useMemo(
    () => (lines ?? []).filter((l) => !supersededIds.has(l.id)),
    [lines, supersededIds],
  );

  // Both legs are resolved identities, so the line match is an id comparison:
  // a bin label whose barcode differs from the code, or a case GTIN instead of
  // the base SKU, both still land on the right count line.
  const active = useMemo(() => {
    const productId = productScan?.identity.productId ?? null;
    if (!binLocationId || !productId) return null;
    return (
      latest.find((l) => l.location_id === binLocationId && l.product_id === productId) ?? null
    );
  }, [binLocationId, productScan, latest]);

  const { data: tracking } = useProductTracking(active?.product_id);

  const handleBinConfirmed = useCallback((confirmed: boolean) => {
    if (!confirmed) setBinLocationId(null);
  }, []);
  const handleProductScan = useCallback((scan: GatedScan | null) => setProductScan(scan), []);

  const addSerial = (raw: string) => {
    const s = raw.trim();
    if (!s) return;
    setSerials((prev) => (prev.some((p) => p.toLowerCase() === s.toLowerCase()) ? prev : [...prev, s]));
    setSerialEntry("");
  };

  const submit = async () => {
    if (!active) {
      toast.error("Scan bin + SKU that match an open line");
      return;
    }
    const n = Number(countedQty);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Enter counted qty");
      return;
    }
    const serialProblem = serialCaptureError(tracking, n, serials);
    if (serialProblem) {
      toast.error(serialProblem);
      return;
    }
    if (tracking?.is_expiry_tracked && !expiry) {
      toast.error("Confirm the expiry date printed on the stock");
      return;
    }
    setBusy(true);
    try {
      const r = await enqueue<{ tolerance_outcome?: string }>("record_count", {
        p_line_id: active.id,
        p_counted_qty: n,
        p_note: null,
        p_serial_numbers: serials.length > 0 ? serials : null,
        p_expiry_date: expiry || null,
      });
      const outcome = r.data?.tolerance_outcome;
      if (r.queued) {
        toast.success("Queued (offline)");
      } else if (outcome === "recount_required") {
        toast.warning("Outside tolerance — count this bin again");
      } else if (outcome === "approval_required") {
        toast.warning("Outside tolerance — supervisor approval needed");
      } else {
        toast.success("Count recorded");
      }
      setBinLocationId(null);
      setProductScan(null);
      setCountedQty("");
      setSerials([]);
      setSerialEntry("");
      setExpiry("");
      setResetKey((k) => k + 1);

      qc.invalidateQueries({ queryKey: ["wms-count-lines", id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const open = latest.filter((l) => l.counted_qty == null);
  const done = latest.length - open.length;
  const recounts = latest.filter((l) => l.tolerance_outcome === "recount_required");


  return (
    <MobileWarehouseLayout
      title="Cycle count"
      back="/wm"
      scanLabel="Scan location or item"
      scanContinuous
      bottomBar={
        <Button className="w-full h-12" size="lg" disabled={busy || !active} onClick={submit}>
          {busy ? "Working…" : active ? `Record @ ${active.location_code ?? ""}` : "Scan bin + SKU"}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded border p-2">
            <div className="text-xs text-muted-foreground">Open</div>
            <div className="text-lg font-semibold">{open.length}</div>
          </div>
          <div className="rounded border p-2">
            <div className="text-xs text-muted-foreground">Done</div>
            <div className="text-lg font-semibold">{done}</div>
          </div>
        </div>
        {blind && (
          <div className="rounded border bg-muted/40 p-2 text-xs text-muted-foreground">
            Blind count — record exactly what is on the shelf. The expected quantity is hidden.
          </div>
        )}
        {recounts.length > 0 && (
          <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs">
            {recounts.length} bin{recounts.length === 1 ? "" : "s"} need counting again.
          </div>
        )}
        <BinScanField
          key={`bin-${resetKey}`}
          label="Scan bin"
          intent="count.location"
          expectedLocationId={null}
          onConfirmedChange={handleBinConfirmed}
          onResolvedLocation={(loc) => setBinLocationId(loc?.location_id ?? null)}
        />
        <ProductScanField
          key={`item-${resetKey}`}
          label="Scan item"
          intent="count.item"
          businessId={currentBusiness?.id}
          onResolved={handleProductScan}
        />

        {active && (
          <div className="rounded border border-primary p-3 text-sm">
            <div className="text-xs text-muted-foreground">Matched line</div>
            <div className="font-medium">{countLineProductLabel(active)}</div>
            {!blind && <div className="text-xs">System qty: {active.system_qty ?? "—"}</div>}
            {(active.recount_round ?? 0) > 0 && (
              <div className="text-xs text-muted-foreground">Recount #{active.recount_round}</div>
            )}
          </div>
        )}
        <div>
          <Label>Counted qty</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={countedQty}
            onChange={(e) => setCountedQty(e.target.value)}
            className="h-12 text-lg"
          />
        </div>

        {tracking?.is_serial_tracked && (
          <div className="space-y-2">
            <Label>Scan each serial number</Label>
            <ScanTextField
              value={serialEntry}
              onChange={setSerialEntry}
              onEnter={(v) => addSerial(v)}
              placeholder="Scan or type, then Enter"
              cameraLabel="Scan serial number"
              continuous
              allowRepeats
              priority={40}
              className="h-12 text-lg"
            />

            <div className="text-xs text-muted-foreground">
              {serials.length} captured{countedQty ? ` of ${Math.round(Number(countedQty) || 0)}` : ""}
            </div>
            {serials.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {serials.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSerials((prev) => prev.filter((p) => p !== s))}
                    className="rounded border px-2 py-1 text-xs font-mono"
                  >
                    {s} ×
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {(tracking?.is_expiry_tracked || tracking?.is_lot_tracked) && (
          <div>
            <Label>
              Expiry date{tracking?.is_expiry_tracked ? "" : " (optional)"}
            </Label>
            <Input
              type="date"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="h-12 text-lg"
            />
          </div>
        )}
      </div>

    </MobileWarehouseLayout>
  );
}
