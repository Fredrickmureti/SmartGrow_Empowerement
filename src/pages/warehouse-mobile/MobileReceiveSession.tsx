/**
 * Mobile receiving loop (Receiving audit, Phase 6).
 *
 * The RF-shaped counterpart to `ReceivingSessionWorkspace`: scan the item,
 * confirm quantity in base units, optionally record lot / expiry / damage /
 * quality hold, capture, next. Capture writes a `wms_receiving_lines` row
 * through `wms_capture_receiving_line` — routed via the offline queue so a
 * dock with no signal keeps receiving, and a drained replay cannot double-post
 * (the queue stamps `client_scan_id` + `device_id`).
 *
 * This screen never flips session state on a scan and never posts inventory;
 * posting stays on the single guarded path `wms_post_receiving_session`.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
import { ProductScanField } from "@/features/warehouse/scanning/ProductScanField";
import type { GatedScan } from "@/features/warehouse/scanning/useWmsIdentityGate";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Truck } from "lucide-react";

interface SessionRow {
  id: string;
  code: string;
  state: string;
  source_doc_type: string | null;
}

interface LineRow {
  id: string;
  product_id: string | null;
  expected_qty: number | null;
  received_qty: number | null;
  damaged_qty: number | null;
  qc_hold: boolean;
  lot_number: string | null;
  line_state: string;
  products: { name: string | null; sku: string | null } | null;
}

const OPEN_STATES = ["open", "in_progress", "captured", "discrepant"];

/** /wm/receiving — open receiving sessions for the operator to walk into. */
export default function MobileReceivingSessions() {
  const { data: sessions } = useQuery({
    queryKey: ["wm-receiving-sessions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_receiving_sessions")
        .select("id, code, state, source_doc_type")
        .in("state", OPEN_STATES)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as SessionRow[];
    },
    refetchInterval: 20000,
  });

  return (
    <MobileWarehouseLayout title="Receiving" back="/wm">
      {(sessions ?? []).length === 0 ? (
        <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
          No open receiving sessions.
        </div>
      ) : (
        <ul className="space-y-2">
          {sessions!.map((s) => (
            <li key={s.id}>
              <Link
                to={`/wm/receiving/${s.id}`}
                className="flex items-center justify-between rounded border p-3 active:bg-muted"
              >
                <div className="flex items-center gap-3">
                  <Truck className="h-5 w-5 text-primary" />
                  <div>
                    <div className="font-mono text-sm">{s.code}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.state}
                      {s.source_doc_type ? ` · ${s.source_doc_type}` : ""}
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

/** /wm/receiving/:id — the scan → qty → lot → confirm loop. */
export function MobileReceiveSession() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const [scan, setScan] = useState<GatedScan | null>(null);
  const [qty, setQty] = useState("");
  const [lot, setLot] = useState("");
  const [expiry, setExpiry] = useState("");
  const [damaged, setDamaged] = useState("");
  const [hold, setHold] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const { data: session } = useQuery({
    queryKey: ["wm-receiving-session", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_receiving_sessions")
        .select("id, code, state, source_doc_type")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as SessionRow | null;
    },
  });

  const { data: lines } = useQuery({
    queryKey: ["wm-receiving-lines", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_receiving_lines" as never)
        .select(
          "id, product_id, expected_qty, received_qty, damaged_qty, qc_hold, lot_number, line_state, products(name, sku)",
        )
        .eq("session_id", id!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as LineRow[];
    },
  });

  /** Expected line for the scanned product, when the PO/ASN was materialised. */
  const matched = useMemo(() => {
    const pid = scan?.identity.productId ?? null;
    if (!pid) return null;
    return (lines ?? []).find((l) => l.product_id === pid) ?? null;
  }, [scan, lines]);

  const outstanding = matched
    ? Math.max(Number(matched.expected_qty ?? 0) - Number(matched.received_qty ?? 0), 0)
    : 0;

  const onResolved = (s: GatedScan | null) => {
    setScan(s);
    if (!s) return;
    const line = (lines ?? []).find((l) => l.product_id === s.identity.productId) ?? null;
    const rest = line
      ? Math.max(Number(line.expected_qty ?? 0) - Number(line.received_qty ?? 0), 0)
      : 0;
    setQty(String(rest || s.baseUnits || 1));
    setLot(s.lot ?? "");
    setExpiry(s.expiry ? s.expiry.toISOString().slice(0, 10) : "");
  };

  const reset = () => {
    setScan(null);
    setQty("");
    setLot("");
    setExpiry("");
    setDamaged("");
    setHold(false);
    setResetKey((k) => k + 1);
  };

  const capture = async () => {
    if (!id || !scan || !Number(qty)) return;
    setBusy(true);
    try {
      const r = await enqueue("wms_capture_receiving_line", {
        p_session_id: id,
        p_product_id: scan.identity.productId,
        p_received_qty: Number(qty),
        p_expected_qty: matched?.expected_qty ?? null,
        p_lpn_id: null,
        p_lot_number: lot.trim() || null,
        p_serial_number: scan.serial ?? null,
        p_uom: null,
        p_staging_location_id: null,
        p_notes: null,
        p_expiry_date: expiry || null,
        p_damaged_qty: Number(damaged) || 0,
        p_qc_hold: hold,
      });
      toast.success(r.queued ? "Queued (offline)" : `Captured ${qty} × ${scan.identity.productName}`);
      reset();
      qc.invalidateQueries({ queryKey: ["wm-receiving-lines", id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Capture failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <MobileWarehouseLayout
      title={session?.code ?? "Receiving"}
      back="/wm/receiving"
      bottomBar={
        <Button
          className="h-12 w-full"
          size="lg"
          disabled={busy || !scan || !Number(qty)}
          onClick={capture}
        >
          {busy ? "Working…" : "Capture line"}
        </Button>
      }
    >
      <div className="space-y-4">
        <ProductScanField
          key={resetKey}
          label="Scan item"
          intent="receiving.item"
          businessId={currentBusiness?.id}
          onResolved={onResolved}
        />

        {scan && (
          <div className="rounded border p-3 text-sm">
            <div className="font-medium">{scan.identity.productName}</div>
            <div className="text-xs text-muted-foreground">
              {matched
                ? `Expected ${matched.expected_qty ?? 0} · received ${matched.received_qty ?? 0} · outstanding ${outstanding}`
                : "Unexpected item — will be captured with expected 0"}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Quantity (base units)</Label>
            <Input
              className="h-12"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <div>
            <Label>Damaged</Label>
            <Input
              className="h-12"
              inputMode="decimal"
              value={damaged}
              onChange={(e) => setDamaged(e.target.value)}
            />
          </div>
          <div>
            <Label>Lot</Label>
            <Input className="h-12" value={lot} onChange={(e) => setLot(e.target.value)} />
          </div>
          <div>
            <Label>Expiry</Label>
            <Input
              className="h-12"
              type="date"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={hold} onCheckedChange={(v) => setHold(!!v)} /> Quality hold
        </label>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            Lines · {(lines ?? []).length}
          </h2>
          <ul className="space-y-2">
            {(lines ?? []).map((l) => (
              <li key={l.id} className="rounded border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">{l.products?.sku ?? "—"}</span>
                  <span className="text-xs text-muted-foreground">{l.line_state}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {l.products?.name ?? "Unknown product"} · {l.received_qty ?? 0}/
                  {l.expected_qty ?? 0}
                  {Number(l.damaged_qty ?? 0) ? ` · ${l.damaged_qty} damaged` : ""}
                  {l.qc_hold ? " · hold" : ""}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </MobileWarehouseLayout>
  );
}
