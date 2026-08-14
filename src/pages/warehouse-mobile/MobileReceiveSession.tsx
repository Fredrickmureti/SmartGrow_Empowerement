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
import { useActiveLpn, tryResolvePlateScan } from "@/features/warehouse/receiving/useReceivingLpn";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScanTextField } from "@/components/scanner/ScanTextField";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
import {
  useReceivingUnitOptions, optionByKey, toBaseUnits, BASE_UNIT_KEY,
} from "@/features/warehouse/receiving/receivingUnits";
import { ProductScanField } from "@/features/warehouse/scanning/ProductScanField";
import type { GatedScan } from "@/features/warehouse/scanning/useWmsIdentityGate";
import { PrintLabelButton } from "@/components/labels/PrintLabelButton";
import { WMS_LABEL_KEY } from "@/features/warehouse/labels/wmsLabels";
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

const OPEN_STATES = ["open", "unloading", "captured", "discrepant"] as const;

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
  // Phase 11 — the operator counts in whatever unit is in their hands; the
  // ledger only ever receives base units.
  const [unitKey, setUnitKey] = useState<string>(BASE_UNIT_KEY);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  // Phase 4c — pallet identity travels with every captured line.
  const { activeLpn, bind: bindLpn, clear: clearLpn, resolving: lpnBusy } =
    useActiveLpn(currentBusiness?.id);
  const [lpnInput, setLpnInput] = useState("");

  const applyLpn = async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const lpn = await bindLpn(trimmed);
      if (lpn) {
        setLpnInput("");
        toast.success(`Plate ${lpn.code}`);
      } else {
        toast.error(`No plate ${trimmed}`);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Plate lookup failed");
    }
  };

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

  // Packaging levels for the scanned product (batched with the session lines).
  const unitOptions = useReceivingUnitOptions(
    useMemo(
      () => [
        ...(lines ?? []).map((l) => l.product_id ?? ""),
        scan?.identity.productId ?? "",
      ].filter(Boolean),
      [lines, scan],
    ),
  );
  const units = (scan && unitOptions.get(scan.identity.productId)) || [];
  const unit = optionByKey(units.length ? units : [
    { key: BASE_UNIT_KEY, label: "ea", uom: "ea", qtyInBaseUom: 1, isBase: true },
  ], unitKey);
  // Entered = what the operator typed, in the unit they picked. The base
  // quantity is derived SERVER-side (`wms_to_base_qty`); `baseQty` here is a
  // preview for the operator only and never reaches the RPC.
  const enteredQty = Number(qty);
  const enteredDamaged = Number(damaged);
  const baseQty = toBaseUnits(enteredQty, unit);
  const baseDamaged = toBaseUnits(enteredDamaged, unit);


  const onResolved = (s: GatedScan | null) => {
    setScan(s);
    if (!s) return;
    const line = (lines ?? []).find((l) => l.product_id === s.identity.productId) ?? null;
    const rest = line
      ? Math.max(Number(line.expected_qty ?? 0) - Number(line.received_qty ?? 0), 0)
      : 0;
    // A scan already carries its packaging level, so the typed quantity that
    // follows is expressed in base units unless the operator changes the unit.
    setUnitKey(BASE_UNIT_KEY);
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
    setUnitKey(BASE_UNIT_KEY);
    setResetKey((k) => k + 1);
  };

  const capture = async () => {
    if (!id || !scan || !baseQty) return;
    setBusy(true);
    try {
      const r = await enqueue("wms_capture_receiving_line", {
        p_session_id: id,
        p_product_id: scan.identity.productId,
        p_received_qty: baseQty,
        p_expected_qty: matched?.expected_qty ?? null,
        p_lpn_id: activeLpn?.id ?? null,
        p_lot_number: lot.trim() || null,
        p_serial_number: scan.serial ?? null,
        p_uom: unit.uom,
        p_staging_location_id: null,
        p_notes: null,
        p_expiry_date: expiry || null,
        p_damaged_qty: baseDamaged,
        p_qc_hold: hold,
      });
      toast.success(
        r.queued ? "Queued (offline)" : `Captured ${baseQty} × ${scan.identity.productName}`,
      );
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
      scanLabel="Scan item or LPN"
      scanContinuous
      bottomBar={
        <Button
          className="h-12 w-full"
          size="lg"
          disabled={busy || !scan || !baseQty}
          onClick={capture}
        >
          {busy ? "Working…" : "Capture line"}
        </Button>
      }
    >
      <div className="space-y-4">
        {activeLpn ? (
          <div className="flex items-center justify-between rounded border bg-muted/40 p-3 text-sm">
            <span>
              Pallet <span className="font-mono font-medium">{activeLpn.code}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={clearLpn}>
              Release
            </Button>
          </div>
        ) : (
          <div>
            <Label>Pallet / LPN (optional)</Label>
            <div className="flex gap-2">
              <ScanTextField
                containerClassName="flex-1"
                className="h-12"
                placeholder="Scan or type plate"
                cameraLabel="Scan pallet / LPN label"
                priority={40}
                value={lpnInput}
                disabled={lpnBusy}
                onChange={setLpnInput}
                onEnter={(v) => void applyLpn(v)}
              />

              <Button
                className="h-12"
                variant="outline"
                disabled={lpnBusy || !lpnInput.trim()}
                onClick={() => void applyLpn(lpnInput)}
              >
                Bind
              </Button>
            </div>
          </div>
        )}

        <ProductScanField
          key={resetKey}
          label="Scan item"
          intent="receiving.item"
          businessId={currentBusiness?.id}
          interceptScan={async (code) => {
            const plate = await tryResolvePlateScan(currentBusiness?.id, code);
            if (!plate) return false;
            await applyLpn(plate.code);
            return true;
          }}
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
            <Label>Quantity</Label>
            <Input
              className="h-12"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <div>
            <Label>Unit</Label>
            <Select value={unitKey} onValueChange={setUnitKey} disabled={units.length < 2}>
              <SelectTrigger className="h-12">
                <SelectValue placeholder="ea" />
              </SelectTrigger>
              <SelectContent>
                {(units.length ? units : [unit]).map((u) => (
                  <SelectItem key={u.key} value={u.key}>{u.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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

        {!unit.isBase && baseQty > 0 && (
          <p className="text-xs text-muted-foreground">
            Books {baseQty} base unit{baseQty === 1 ? "" : "s"}
            {baseDamaged > 0 ? ` · ${baseDamaged} damaged` : ""}
          </p>
        )}

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
                {/* Receiving audit Phase 7 — every receiving print goes
                    through the canonical WMS label keys and the shared seam. */}
                <div className="mt-2 flex gap-2">
                  <PrintLabelButton
                    label="Put-away"
                    templateKey={WMS_LABEL_KEY.PUTAWAY}
                    workflow="receiving"
                    product={{
                      id: l.product_id ?? l.id,
                      name: l.products?.name ?? "Item",
                      sku: l.products?.sku ?? "",
                      barcode: null,
                    }}
                    sourceDocType="wms_receiving_line"
                    sourceDocId={l.id}
                    idempotencyKey={`${WMS_LABEL_KEY.PUTAWAY}:${l.id}`}
                    extraVars={{ lot: l.lot_number ?? "", qty: l.received_qty ?? 0 }}
                    className="h-10 flex-1"
                  />
                  {l.qc_hold || Number(l.damaged_qty ?? 0) > 0 ? (
                    <PrintLabelButton
                      label={l.qc_hold ? "Hold" : "Quarantine"}
                      templateKey={
                        l.qc_hold ? WMS_LABEL_KEY.QUALITY_HOLD : WMS_LABEL_KEY.QUARANTINE
                      }
                      workflow="receiving"
                      variant="destructive"
                      product={{
                        id: l.product_id ?? l.id,
                        name: l.products?.name ?? "Item",
                        sku: l.products?.sku ?? "",
                        barcode: null,
                      }}
                      sourceDocType="wms_receiving_line"
                      sourceDocId={l.id}
                      idempotencyKey={`${l.qc_hold ? WMS_LABEL_KEY.QUALITY_HOLD : WMS_LABEL_KEY.QUARANTINE}:${l.id}`}
                      extraVars={{ lot: l.lot_number ?? "", qty: l.damaged_qty ?? 0 }}
                      className="h-10 flex-1"
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </MobileWarehouseLayout>
  );
}
