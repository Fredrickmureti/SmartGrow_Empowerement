/**
 * Mobile handling-unit screen — scan a plate, see what it carries, move it.
 *
 * This is the forklift/RF view of the same domain the desk cockpit uses:
 * contents are `stock_quants.lpn_id` rows and every mutation is one of the
 * plate RPCs. Calls go through the mobile `enqueue()` chokepoint, so a
 * dropped connection queues the operation (replay-guarded) instead of
 * losing it.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWmsScanIntent } from "@/features/warehouse/scanning/wmsScanIntent";
import { BinScanField } from "@/features/warehouse/locations/BinScanField";
import type { ResolvedLocation } from "@/features/warehouse/locations/useResolveLocationIdentity";
import { useWarehouseQtyFormatter, WarehouseQty, AggregateQty } from "@/features/warehouse/quantity/warehouseQty";
import {
  useLpn, useLpnContents, resolveLpnByCode,
} from "@/features/warehouse/lpn/useLpnOps";

/** Scan-to-find entry screen: /wm/plate */
export default function MobilePlateLookup() {
  const nav = useNavigate();
  const { currentBusiness } = useBusinesses();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const open = async (value: string) => {
    if (!currentBusiness?.id || !value.trim()) return;
    setBusy(true);
    try {
      const plate = await resolveLpnByCode(currentBusiness.id, value);
      if (!plate) return toast.error(`No plate ${value}`);
      nav(`/wm/plate/${plate.id}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  };

  useWmsScanIntent({
    intent: "putaway.lpn",
    label: "wm-plate-lookup",
    onScan: (p) => { void open(p.resolveCode); },
  });

  return (
    <MobileWarehouseLayout title="License plate" back="/wm" scanLabel="Scan plate label">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Scan a plate label, or type its code.
        </p>
        <Input
          autoFocus
          inputMode="text"
          className="h-12 font-mono text-lg"
          placeholder="PLT-…"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void open(code); }}
        />
        <Button className="h-12 w-full" size="lg" disabled={busy || !code.trim()} onClick={() => void open(code)}>
          {busy ? "Looking up…" : "Open plate"}
        </Button>
      </div>
    </MobileWarehouseLayout>
  );
}

/** Handling-unit detail: /wm/plate/:id */
export function MobilePlateDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data: plate, isLoading } = useLpn(id);
  const { data: contents } = useLpnContents(id);
  const [busy, setBusy] = useState(false);
  const [dest, setDest] = useState<ResolvedLocation | null>(null);
  const qtyFmt = useWarehouseQtyFormatter((contents ?? []).map((c) => c.product_id));

  const move = async (bin: ResolvedLocation | null) => {
    if (!plate || !bin) return;
    setBusy(true);
    try {
      const r = await enqueue("wms_lpn_move", {
        _lpn_id: plate.id,
        _to_location_id: bin.location_id,
        // Optimistic concurrency is mandatory server-side: send the revision
        // this screen is showing, so a stale RF handset is rejected.
        _expected_version: plate.row_version,
        _reason: "RF plate move",
      });
      toast.success(r.queued ? "Queued (offline)" : `Moved to ${bin.code}`);
      setDest(null);
      qc.invalidateQueries({ queryKey: ["wms-lpn", plate.id] });
      qc.invalidateQueries({ queryKey: ["wms-lpn-contents", plate.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Move failed");
    } finally {
      setBusy(false);
    }
  };
  /* The destination prompt is `BinScanField`: it owns the `putaway.bin`
     intent, resolves the label through `resolve_location_identity` (so a
     printed barcode that differs from the code still works), and refuses
     product barcodes outright. */

  if (isLoading) return <MobileWarehouseLayout title="Plate" back="/wm/plate">Loading…</MobileWarehouseLayout>;
  if (!plate) return <MobileWarehouseLayout title="Plate" back="/wm/plate">Plate not found.</MobileWarehouseLayout>;

  const units = (contents ?? []).reduce((a, c) => a + Number(c.quantity || 0), 0);

  return (
    <MobileWarehouseLayout
      title={plate.code}
      back="/wm/plate"
      scanLabel="Scan the destination bin"

      bottomBar={
        <Button
          className="h-12 w-full"
          size="lg"
          disabled={busy || !dest}
          onClick={() => void move(dest)}
        >
          {busy ? "Working…" : "Move plate"}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="rounded border p-3">
          <div className="text-xs text-muted-foreground">Status · Type</div>
          <div className="font-medium capitalize">{plate.status} · {plate.lpn_type}</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border p-3">
            <div className="text-xs text-muted-foreground">Bin</div>
            <div className="font-mono">{plate.location_code ?? "Unlocated"}</div>
            {plate.location_path && (
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">{plate.location_path}</div>
            )}
          </div>
          <div className="rounded border p-3">
            <div className="text-xs text-muted-foreground">Contents</div>
            <div>{(contents ?? []).length} SKU · <AggregateQty qty={units} /></div>
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">On this plate</h2>
          {!(contents ?? []).length ? (
            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
              Empty handling unit.
            </div>
          ) : (
            <ul className="space-y-2">
              {contents!.map((c) => (
                <li key={c.id} className="flex items-center justify-between rounded border p-3">
                  <div>
                    <div className="text-sm">{c.products?.name ?? c.product_id.slice(0, 8)}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {c.products?.sku ?? ""}{c.lot_number ? ` · ${c.lot_number}` : ""}
                    </div>
                  </div>
                  <div className="tabular-nums">
                    <WarehouseQty fmt={qtyFmt} productId={c.product_id} baseQty={c.quantity} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <BinScanField
          label="Destination bin"
          intent="putaway.bin"
          expectedLocationId={null}
          warehouseId={plate.warehouse_id}
          disabled={busy}
          onConfirmedChange={() => {}}
          onResolvedLocation={setDest}
        />
      </div>
    </MobileWarehouseLayout>
  );
}