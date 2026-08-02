/**
 * Mobile cycle count — scan bin + item, enter counted qty, record.
 *
 * Both legs run on their resolver seams: `BinScanField`
 * (`resolve_location_identity`, ADR 0104) and `ProductScanField`
 * (`resolve_product_identity`, ADR-0017/0071). Neither leg string-compares.
 */
import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { BinScanField } from "@/features/warehouse/locations/BinScanField";
import { ProductScanField } from "@/features/warehouse/scanning/ProductScanField";
import type { GatedScan } from "@/features/warehouse/scanning/useWmsIdentityGate";
import { useBusinesses } from "@/hooks/useBusinesses";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";

interface Line {
  id: string;
  system_qty: number | null;
  counted_qty: number | null;
  variance_qty: number | null;
  location_id: string | null;
  product_id: string | null;
  location: { code: string | null } | null;
  product: { sku: string | null; name: string | null } | null;
}

export default function MobileCount() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const [binLocationId, setBinLocationId] = useState<string | null>(null);
  const [productScan, setProductScan] = useState<GatedScan | null>(null);
  const [countedQty, setCountedQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const { data: lines } = useQuery({
    queryKey: ["wm-count-lines", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_count_lines")
        .select(
          "id, system_qty, counted_qty, variance_qty, location_id, product_id, location:location_id(code), product:product_id(sku, name)",
        )
        .eq("session_id", id!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as Line[];
    },
  });

  // Both legs are resolved identities, so the line match is an id comparison:
  // a bin label whose barcode differs from the code, or a case GTIN instead of
  // the base SKU, both still land on the right count line.
  const active = useMemo(() => {
    const productId = productScan?.identity.productId ?? null;
    if (!binLocationId || !productId) return null;
    return (
      (lines ?? []).find((l) => l.location_id === binLocationId && l.product_id === productId) ??
      null
    );
  }, [binLocationId, productScan, lines]);

  const handleBinConfirmed = useCallback((confirmed: boolean) => {
    if (!confirmed) setBinLocationId(null);
  }, []);
  const handleProductScan = useCallback((scan: GatedScan | null) => setProductScan(scan), []);


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
    setBusy(true);
    try {
      const r = await enqueue("record_count", {
        p_line_id: active.id,
        p_counted_qty: n,
        p_note: null,
      });
      toast.success(r.queued ? "Queued (offline)" : "Count recorded");
      setBinLocationId(null);
      setProductScan(null);
      setCountedQty("");
      setResetKey((k) => k + 1);

      qc.invalidateQueries({ queryKey: ["wm-count-lines", id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const open = (lines ?? []).filter((l) => l.counted_qty == null);
  const done = (lines ?? []).length - open.length;

  return (
    <MobileWarehouseLayout
      title="Cycle count"
      back="/wm"
      bottomBar={
        <Button className="w-full h-12" size="lg" disabled={busy || !active} onClick={submit}>
          {busy ? "Working…" : active ? `Record @ ${active.location?.code}` : "Scan bin + SKU"}
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
            <div className="font-medium">{active.product?.name}</div>
            <div className="text-xs">System qty: {active.system_qty ?? "—"}</div>
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
      </div>
    </MobileWarehouseLayout>
  );
}
