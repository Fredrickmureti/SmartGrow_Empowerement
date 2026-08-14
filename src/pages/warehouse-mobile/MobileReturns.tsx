/**
 * Mobile returns loop (Returns audit, Phase 5).
 *
 * The RF-shaped counterpart to `ReturnWorkspace`: scan the returned item,
 * confirm quantity, pick the condition, capture. Capture writes a
 * `wms_return_lines` row through `wms_capture_return_line` — routed via the
 * offline queue so an RMA dock with no signal keeps working, and a drained
 * replay cannot double-count a unit (the queue stamps `client_scan_id` +
 * `device_id`, and the server dedups on that pair).
 *
 * This screen never flips header state and never posts inventory: posting
 * stays on the guarded path `wms_post_return_dispositions`. Disposition of a
 * damaged/defective line also stays off the handheld capture loop — the
 * server requires photo evidence, which the desktop dialog collects.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ProductScanField } from "@/features/warehouse/scanning/ProductScanField";
import type { GatedScan } from "@/features/warehouse/scanning/useWmsIdentityGate";
import { PrintLabelButton } from "@/components/labels/PrintLabelButton";
import { WMS_LABEL_KEY } from "@/features/warehouse/labels/wmsLabels";
import { useBusinesses } from "@/hooks/useBusinesses";
import { RETURN_CONDITIONS, type ReturnCondition } from "@/features/warehouse/returns/returnsModel";
import { Undo2 } from "lucide-react";

interface ReturnRow {
  id: string;
  code: string;
  state: string;
  return_kind: string;
  rma_reference: string | null;
}

interface LineRow {
  id: string;
  product_id: string | null;
  expected_qty: number | null;
  received_qty: number | null;
  condition_code: string | null;
  inspection_state: string;
  disposition: string | null;
  blocked_reason: string | null;
  products: { name: string | null; sku: string | null } | null;
}

const OPEN_STATES = ["authorized", "in_transit", "received", "inspecting"] as const;

function label(value: string | null | undefined): string {
  return value ? value.replace(/_/g, " ") : "—";
}

/** /wm/returns — open RMAs the operator can walk into. */
export default function MobileReturnList() {
  const { currentBusiness } = useBusinesses();
  const { data: returns } = useQuery({
    queryKey: ["wm-returns", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_return_orders" as never)
        .select("id, code, state, return_kind, rma_reference")
        .eq("business_id", currentBusiness!.id)
        .in("state", OPEN_STATES as unknown as string[])
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as ReturnRow[];
    },
    refetchInterval: 20000,
  });

  return (
    <MobileWarehouseLayout title="Returns" back="/wm">
      {(returns ?? []).length === 0 ? (
        <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
          No open returns.
        </div>
      ) : (
        <ul className="space-y-2">
          {returns!.map((r) => (
            <li key={r.id}>
              <Link
                to={`/wm/returns/${r.id}`}
                className="flex items-center justify-between rounded border p-3 active:bg-muted"
              >
                <div className="flex items-center gap-3">
                  <Undo2 className="h-5 w-5 text-primary" />
                  <div>
                    <div className="font-mono text-sm">{r.code}</div>
                    <div className="text-xs text-muted-foreground">
                      {label(r.state)} · {label(r.return_kind)}
                      {r.rma_reference ? ` · ${r.rma_reference}` : ""}
                    </div>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">tap →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </MobileWarehouseLayout>
  );
}

/** /wm/returns/:id — the scan → qty → condition → capture loop. */
export function MobileReturnWorkspace() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const [scan, setScan] = useState<GatedScan | null>(null);
  const [qty, setQty] = useState("");
  const [condition, setCondition] = useState<ReturnCondition>("unopened");
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const { data: order } = useQuery({
    queryKey: ["wm-return", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_return_orders" as never)
        .select("id, code, state, return_kind, rma_reference")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as ReturnRow | null;
    },
  });

  const { data: lines } = useQuery({
    queryKey: ["wm-return-lines", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_return_lines" as never)
        .select(
          "id, product_id, expected_qty, received_qty, condition_code, inspection_state, disposition, blocked_reason, products(name, sku)",
        )
        .eq("return_order_id", id!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as LineRow[];
    },
  });

  /** Expected line for the scanned product, when the RMA was pre-authorised. */
  const matched = useMemo(() => {
    const pid = scan?.identity.productId ?? null;
    if (!pid) return null;
    return (lines ?? []).find((l) => l.product_id === pid) ?? null;
  }, [scan, lines]);

  const outstanding = matched
    ? Math.max(Number(matched.expected_qty ?? 0) - Number(matched.received_qty ?? 0), 0)
    : 0;

  // Returns arrive in whatever the customer shipped — often cases. The device
  // sends the packaging level; `wms_capture_return_line` converts to base.
  const { packsByProduct } = useProductPackagingBatch(
    scan?.identity.productId ? [scan.identity.productId] : [],
  );
  const units = useMemo(
    () => unitOptionsFor(scan?.identity.productId ? packsByProduct.get(scan.identity.productId) : []),
    [packsByProduct, scan?.identity.productId],
  );
  const unit = units.find((u) => u.key === unitKey) ?? units[0];

  const reset = () => {
    setScan(null);
    setQty("");
    setUnitKey(BASE_UNIT_KEY);
    setCondition("unopened");
    setResetKey((k) => k + 1);
  };

  const capture = async () => {
    if (!id || !scan) return;
    const amount = Number(qty || outstanding || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Quantity must be greater than zero");
      return;
    }
    setBusy(true);
    try {
      const res = await enqueue("wms_capture_return_line", {
        p_return_id: id,
        p_product_id: scan.identity.productId,
        p_received_qty: amount,
        p_entered_qty: amount,
        p_packaging_id: unit?.packagingId ?? null,
        p_expected_qty: matched ? matched.expected_qty : null,
        p_lot_number: scan.lot,
        p_serial_number: scan.serial,
        p_uom: unit && !unit.isBase ? unit.uom : null,
        p_condition_code: condition,
        p_notes: null,
      });
      toast.success(res.queued ? "Queued — will sync when back online" : "Line captured");
      await qc.invalidateQueries({ queryKey: ["wm-return-lines", id] });
      reset();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Capture rejected");
    } finally {
      setBusy(false);
    }
  };


  return (
    <MobileWarehouseLayout title={order?.code ?? "Return"} back="/wm/returns" scanLabel="Scan returned item">
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded border p-3">
          <div>
            <div className="text-xs uppercase text-muted-foreground">state</div>
            <div className="text-sm">{label(order?.state)}</div>
          </div>
          {order && (
            <PrintLabelButton
              label="Receipt label"
              templateKey={WMS_LABEL_KEY.RETURN_RECEIPT}
              workflow="receiving"
              product={{ id: order.id, name: order.code, sku: order.rma_reference ?? "", barcode: null }}
              sourceDocType="wms_return_order"
              sourceDocId={order.id}
              idempotencyKey={`${WMS_LABEL_KEY.RETURN_RECEIPT}:${order.id}`}
              extraVars={{
                return_code: order.code,
                rma_reference: order.rma_reference ?? "",
                return_kind: order.return_kind,
              }}
            />
          )}
        </div>

        <ProductScanField
          key={resetKey}
          label="Scan returned item"
          intent="returns.item"
          businessId={currentBusiness?.id}
          onResolved={setScan}
        />

        {scan && (
          <div className="space-y-3 rounded border p-3">
            <div className="text-sm font-medium">{scan.identity.productName ?? "Product"}</div>
            {matched && (
              <div className="text-xs text-muted-foreground">
                Authorised outstanding: <span className="tabular-nums">{outstanding}</span>
              </div>
            )}
            <div>
              <Label>Quantity</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                className="h-12 text-lg"
                value={qty}
                placeholder={outstanding ? String(outstanding) : "0"}
                onChange={(e) => setQty(e.target.value)}
              />
            </div>
            <div>
              <Label>Condition</Label>
              <Select value={condition} onValueChange={(v) => setCondition(v as ReturnCondition)}>
                <SelectTrigger className="h-12"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RETURN_CONDITIONS.map((c) => (
                    <SelectItem key={c} value={c}>{label(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(condition === "damaged" || condition === "defective") && (
              <p className="text-xs text-muted-foreground">
                Photo evidence is required before this line can be dispositioned — capture it on the
                inspection desk.
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="h-12 flex-1" onClick={reset} disabled={busy}>
                Clear
              </Button>
              <Button className="h-12 flex-1" onClick={capture} disabled={busy}>
                Capture
              </Button>
            </div>
          </div>
        )}

        <div>
          <div className="mb-2 text-xs uppercase text-muted-foreground">
            Captured ({(lines ?? []).length})
          </div>
          <ul className="space-y-1">
            {(lines ?? []).map((l) => (
              <li
                key={l.id}
                className={`rounded border p-2 text-sm ${l.blocked_reason ? "border-destructive/50" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate">{l.products?.name ?? l.products?.sku ?? "—"}</span>
                  <span className="tabular-nums">{Number(l.received_qty ?? 0)}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {label(l.condition_code)} · {label(l.inspection_state)}
                  {l.disposition ? ` · ${label(l.disposition)}` : ""}
                </div>
                {l.blocked_reason && (
                  <div className="text-xs text-destructive">{l.blocked_reason}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </MobileWarehouseLayout>
  );
}
