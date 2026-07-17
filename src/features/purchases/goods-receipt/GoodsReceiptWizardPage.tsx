// @ts-nocheck
/**
 * GoodsReceiptWizardPage — full-route WizardShell replacing the legacy
 * `GoodsReceiptDialog` drawer. Three steps:
 *
 *   1. Setup      — destination warehouse + optional notes
 *   2. Receive    — line quantities (scan or manual) with pack/lot capture
 *   3. Confirm    — review totals and post the GRN atomically
 *
 * URL contract:
 *   /purchases/goods-receipt/new?po=<purchase_order_id>&step=<setup|receive|confirm>
 *
 * Uses `?step=` URL state per the DS wizard contract; each step validates
 * before Next is enabled. Posts through the same
 * `complete_goods_receipt_atomic` RPC as the retired dialog so accounting
 * behavior is identical.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, Package, CheckCircle2, ArrowLeft } from "lucide-react";

import {
  ActionBar,
  ErrorState,
  FooterActionBar,
  LoadingState,
  RecordHeader,
  Section,
  WizardShell,
  WizardStepper,
  type WizardStep,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { BarcodeInputField } from "@/components/scanner/BarcodeInputField";
import { ScannerPairingButton } from "@/components/scanner/ScannerPairingButton";
import { PackagingSelect } from "@/components/products/PackagingSelect";
import { useProductTrackingFlags } from "@/hooks/useProductTrackingFlags";

import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useAuth } from "@/contexts/AuthContext";
import { useResolveBarcode } from "@/hooks/pos/useResolveBarcode";
import { useActiveScanContext } from "@/hooks/pos/useActiveScanContext";
import { useGs1Scanner } from "@/lib/gs1/useGs1Scanner";
import { normalizeError } from "@/services/resilience";
import type { PurchaseOrder } from "@/hooks/usePurchaseOrders";

type StepId = "setup" | "receive" | "confirm";

const STEPS: WizardStep[] = [
  { id: "setup", label: "Setup", description: "Destination & context" },
  { id: "receive", label: "Receive", description: "Enter or scan quantities" },
  { id: "confirm", label: "Confirm", description: "Review & post GRN" },
];

interface ReceiptLine {
  po_item_id: string;
  product_id: string | null;
  description: string;
  quantity_ordered: number;
  quantity_previously_received: number;
  quantity_to_receive: number;
  lot_number: string;
  serial_number: string;
  // Phase A.5 — per-unit serials for is_serial_tracked products.
  // When the line's product is serial-tracked, this array MUST have
  // exactly `quantity_to_receive` unique non-empty entries; the
  // submit handler expands the line into that many single-qty
  // goods_receipt_items rows so the stock_movements trigger
  // (`enforce_serial_on_movement`, ADR-0067) upserts one row into
  // stock_serials per unit.
  serial_numbers: string[];
  notes: string;
  packaging_id: string | null;
  display_uom_id: string | null;
  display_quantity: number | null;
  // Phase D.2 · ASN prefill provenance
  inbound_shipment_item_id: string | null;
  expected_quantity: number | null;
  expected_expiry_date: string | null;
  expected_manufacture_date: string | null;
  // Phase H+ · Captured from GS1 AI 17 / AI 11 during the scan flow; used
  // by handleSubmit to upsert `stock_lots.expiry_date` / `manufacture_date`
  // after the atomic RPC creates the lot row. Falls back to the ASN
  // expected_* values above.
  captured_expiry_date: string | null;
  captured_manufacture_date: string | null;
}

interface ActiveShipment {
  id: string;
  shipment_number: string;
  status: string;
  items_by_po_item: Record<string, any>;
  items_by_product: Record<string, any>;
}

export default function GoodsReceiptWizardPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const poId = params.get("po") ?? "";
  const rawStep = (params.get("step") ?? "setup") as StepId;
  const activeStep: StepId = (["setup", "receive", "confirm"] as StepId[]).includes(rawStep)
    ? rawStep
    : "setup";

  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { user } = useAuth();
  const { warehouses } = useWarehouses();

  useActiveScanContext({ workspace_id: "grn" });

  const { resolveTagged } = useResolveBarcode(
    currentBusiness?.id,
    currentBranch?.id ?? null,
  );

  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeShipment, setActiveShipment] = useState<ActiveShipment | null>(null);

  const [warehouseId, setWarehouseId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [appointmentId, setAppointmentId] = useState<string>("");
  const [appointments, setAppointments] = useState<Array<{ id: string; reference: string | null; window_start: string; window_end: string; state: string; dock_code?: string | null }>>([]);

  // Load inbound appointments for the caller's business that are still
  // schedulable (scheduled|arrived). Filtering by warehouse is deferred
  // to visual context via dock code — the RPC does the auth check.
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("wms_dock_appointments")
        .select("id, reference, window_start, window_end, state, warehouse_id, dock:warehouse_docks(code)")
        .eq("appointment_type", "inbound")
        .in("state", ["scheduled", "arrived"])
        .order("window_start");
      if (!alive) return;
      const rows = (data ?? []).filter((r: any) => !warehouseId || r.warehouse_id === warehouseId)
        .map((r: any) => ({ id: r.id, reference: r.reference, window_start: r.window_start, window_end: r.window_end, state: r.state, dock_code: r.dock?.code ?? null }));
      setAppointments(rows);
    })();
    return () => { alive = false; };
  }, [warehouseId]);
  const [receiptLines, setReceiptLines] = useState<ReceiptLine[]>([]);
  const [scanCode, setScanCode] = useState("");
  const [scanFlash, setScanFlash] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load PO + any active ASN (Phase D.2)
  useEffect(() => {
    if (!poId) {
      setLoading(false);
      setLoadError("Missing purchase order. Open this wizard from a PO row.");
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("*, vendor:contacts(name), items:purchase_order_items(*)")
        .eq("id", poId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setLoadError(error.message);
        setLoading(false);
        return;
      }
      if (!data) {
        setLoadError("Purchase order not found.");
        setLoading(false);
        return;
      }
      const loaded = data as unknown as PurchaseOrder;
      setPo(loaded);

      // Look for an active ASN linked to this PO. Prefer dispatched/in_transit,
      // fall back to draft. Ignore already-received / cancelled shipments.
      const { data: shipments } = await supabase
        .from("inbound_shipments")
        .select("id, shipment_number, status, dispatched_at, expected_arrival_at, items:inbound_shipment_items(*)")
        .eq("purchase_order_id", poId)
        .in("status", ["draft", "dispatched", "in_transit"])
        .order("dispatched_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
      if (cancelled) return;

      const shipment = (shipments ?? []).find((s: any) =>
        ["dispatched", "in_transit"].includes(s.status),
      ) ?? (shipments ?? [])[0] ?? null;

      const byPoItem: Record<string, any> = {};
      const byProduct: Record<string, any> = {};
      if (shipment) {
        for (const it of (shipment as any).items ?? []) {
          if (it.purchase_order_item_id) byPoItem[it.purchase_order_item_id] = it;
          if (it.product_id) byProduct[it.product_id] = it;
        }
        setActiveShipment({
          id: shipment.id,
          shipment_number: shipment.shipment_number,
          status: shipment.status,
          items_by_po_item: byPoItem,
          items_by_product: byProduct,
        });
      } else {
        setActiveShipment(null);
      }

      setReceiptLines(
        (loaded.items ?? []).map((item) => {
          const asnMatch =
            (item.id && byPoItem[item.id]) ||
            (item.product_id && byProduct[item.product_id]) ||
            null;
          const remaining = item.quantity - (item.quantity_received || 0);
          const expected = asnMatch ? Number(asnMatch.expected_quantity) : null;
          const prefillQty =
            expected != null ? Math.min(Math.max(expected, 0), remaining) : remaining;
          return {
            po_item_id: item.id || "",
            product_id: item.product_id,
            description: item.description,
            quantity_ordered: item.quantity,
            quantity_previously_received: item.quantity_received || 0,
            quantity_to_receive: prefillQty,
            lot_number: asnMatch?.expected_lot_number ?? "",
            serial_number: "",
            serial_numbers: [],
            notes: "",
            packaging_id: asnMatch?.expected_packaging_id ?? null,
            display_uom_id: asnMatch?.display_uom_id ?? null,
            display_quantity: asnMatch?.display_quantity ?? null,
            inbound_shipment_item_id: asnMatch?.id ?? null,
            expected_quantity: expected,
            expected_expiry_date: asnMatch?.expected_expiry_date ?? null,
            expected_manufacture_date: asnMatch?.expected_manufacture_date ?? null,
            captured_expiry_date: asnMatch?.expected_expiry_date ?? null,
            captured_manufacture_date: asnMatch?.expected_manufacture_date ?? null,
          };
        }),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [poId]);


  const goToStep = useCallback(
    (step: StepId) => {
      const next = new URLSearchParams(params);
      next.set("step", step);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const completedStepIds = useMemo(() => {
    const done: StepId[] = [];
    if (warehouseId) done.push("setup");
    if (done.includes("setup") && receiptLines.some((l) => l.quantity_to_receive > 0)) {
      done.push("receive");
    }
    return done;
  }, [warehouseId, receiptLines]);

  const totalToReceive = useMemo(
    () => receiptLines.reduce((sum, l) => sum + (l.quantity_to_receive || 0), 0),
    [receiptLines],
  );

  // Phase A.5 — resolve tracking flags for every product in the receipt so
  // the receive step can render a per-unit serial capture for
  // is_serial_tracked lines. One batched round-trip per page load.
  const productIdsInReceipt = useMemo(
    () =>
      Array.from(
        new Set(
          receiptLines
            .map((l) => l.product_id)
            .filter((id): id is string => !!id),
        ),
      ),
    [receiptLines],
  );
  const { get: getTrackingFlags } = useProductTrackingFlags(productIdsInReceipt);

  /** Serial-tracked lines whose serial_numbers[] does not yet match qty. */
  const serialCaptureIncomplete = useMemo(() => {
    return receiptLines.some((l) => {
      if (!l.product_id || l.quantity_to_receive <= 0) return false;
      if (!getTrackingFlags(l.product_id).is_serial_tracked) return false;
      const cleaned = (l.serial_numbers ?? [])
        .map((s) => s.trim())
        .filter(Boolean);
      const unique = new Set(cleaned);
      return (
        cleaned.length !== Math.round(l.quantity_to_receive) ||
        unique.size !== cleaned.length
      );
    });
  }, [receiptLines, getTrackingFlags]);

  const updateLine = (index: number, field: keyof ReceiptLine, value: any) => {
    setReceiptLines((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const handleReceiveAll = () => {
    setReceiptLines((prev) =>
      prev.map((line) => ({
        ...line,
        quantity_to_receive: line.quantity_ordered - line.quantity_previously_received,
      })),
    );
  };

  const { interpret: interpretGs1Scan } = useGs1Scanner();

  const handleScanReceive = async (code: string) => {
    const norm = code.trim();
    if (!norm) return;
    setScanCode("");

    // Phase H — GS1 payloads carry GTIN + lot + expiry + serial + qty
    // in a single scan. Resolve the product by GTIN, then prefill the
    // matched line's lot_number and (for serial-tracked lines) append
    // the scanned serial. `resolveCode` is the GTIN when GS1, else the
    // raw scan — so non-GS1 payloads take the legacy path unchanged.
    const gs1 = interpretGs1Scan(norm);

    const resolved = await resolveTagged(gs1.resolveCode);
    let idx = -1;
    let qtyDelta = gs1.normalized.quantity && gs1.normalized.quantity > 0
      ? Math.round(gs1.normalized.quantity)
      : 1;
    if (resolved.kind === "hit") {
      if (!gs1.isGs1) {
        qtyDelta = Math.max(1, Math.round(resolved.row.scanQuantity || 1));
      }
      idx = receiptLines.findIndex(
        (line) => line.product_id && line.product_id === resolved.row.productId,
      );
      if (idx >= 0 && resolved.row.packagingId) {
        setReceiptLines((prev) => {
          const updated = [...prev];
          const prevDisplay = updated[idx].display_quantity || 0;
          updated[idx] = {
            ...updated[idx],
            packaging_id: resolved.row.packagingId,
            display_quantity: prevDisplay + 1,
          };
          return updated;
        });
      }
    }
    if (idx < 0) {
      idx = receiptLines.findIndex((line) => {
        const item = po?.items?.find((it: any) => it.id === line.po_item_id);
        const sku = (item?.product as any)?.sku;
        return sku && String(sku).toLowerCase() === norm.toLowerCase();
      });
    }
    if (idx < 0) {
      setScanFlash(`"${norm}" is not on this purchase order.`);
      window.setTimeout(() => setScanFlash(null), 2500);
      return;
    }
    const max =
      receiptLines[idx].quantity_ordered - receiptLines[idx].quantity_previously_received;
    const next = Math.min((receiptLines[idx].quantity_to_receive || 0) + qtyDelta, max);
    updateLine(idx, "quantity_to_receive", next);

    // GS1 prefill: lot + serial (expiry is captured via stock_lots on
    // the goods-receipt path; the flash surfaces it for the operator).
    if (gs1.isGs1) {
      const line = receiptLines[idx];
      if (gs1.normalized.lot && !line.lot_number) {
        updateLine(idx, "lot_number", gs1.normalized.lot);
      }
      if (gs1.normalized.serial) {
        const isSerial =
          !!line.product_id &&
          getTrackingFlags(line.product_id).is_serial_tracked;
        if (isSerial) {
          const existing = line.serial_numbers ?? [];
          if (!existing.includes(gs1.normalized.serial)) {
            updateLine(idx, "serial_numbers", [
              ...existing,
              gs1.normalized.serial,
            ]);
          }
        } else {
          updateLine(idx, "serial_number", gs1.normalized.serial);
        }
      }
      if (gs1.normalized.expiry) {
        updateLine(
          idx,
          "captured_expiry_date",
          gs1.normalized.expiry.toISOString().slice(0, 10),
        );
      }
      if (gs1.normalized.productionDate) {
        updateLine(
          idx,
          "captured_manufacture_date",
          gs1.normalized.productionDate.toISOString().slice(0, 10),
        );
      }
      const expBits = gs1.normalized.expiry
        ? ` · exp ${gs1.normalized.expiry.toISOString().slice(0, 10)}`
        : "";
      const lotBits = gs1.normalized.lot ? ` · lot ${gs1.normalized.lot}` : "";
      setScanFlash(
        `+${qtyDelta} ${receiptLines[idx].description} (now ${next})${lotBits}${expBits}`,
      );
    } else {
      setScanFlash(`+${qtyDelta} ${receiptLines[idx].description} (now ${next})`);
    }
    window.setTimeout(() => setScanFlash(null), 1800);
  };

  const handleSubmit = async () => {
    if (!po || !currentOrg || !user) return;
    const linesToReceive = receiptLines.filter((l) => l.quantity_to_receive > 0);
    if (linesToReceive.length === 0) {
      toast({
        title: "No items to receive",
        description: "Enter quantities to receive.",
        variant: "destructive",
      });
      return;
    }
    if (!warehouseId) {
      toast({
        title: "Warehouse required",
        description: "Select a destination warehouse before receiving goods.",
        variant: "destructive",
      });
      return;
    }
    for (const line of linesToReceive) {
      const maxReceivable = line.quantity_ordered - line.quantity_previously_received;
      if (line.quantity_to_receive > maxReceivable) {
        toast({
          title: "Invalid quantity",
          description: `Cannot receive more than ${maxReceivable} for "${line.description}"`,
          variant: "destructive",
        });
        return;
      }
      // Phase A.5 — serial-tracked lines must carry one unique serial per unit.
      if (line.product_id && getTrackingFlags(line.product_id).is_serial_tracked) {
        const cleaned = (line.serial_numbers ?? []).map((s) => s.trim()).filter(Boolean);
        const unique = new Set(cleaned);
        if (
          cleaned.length !== Math.round(line.quantity_to_receive) ||
          unique.size !== cleaned.length
        ) {
          toast({
            title: "Serial numbers required",
            description: `"${line.description}" is serial-tracked — enter ${Math.round(
              line.quantity_to_receive,
            )} unique serial number(s) before posting.`,
            variant: "destructive",
          });
          return;
        }
      }
    }

    setIsSubmitting(true);
    try {
      const { data: grnNumber, error: numError } = await supabase.rpc(
        "get_next_grn_number",
        { _org_id: currentOrg.id },
      );
      if (numError) throw numError;

      const { data: wh, error: whErr } = await supabase
        .from("warehouses")
        .select("id, branch_id, business_id")
        .eq("id", warehouseId)
        .single();
      if (whErr) throw whErr;

      const { data: receipt, error: receiptError } = await supabase
        .from("goods_receipts")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id || wh.business_id,
          branch_id: wh.branch_id,
          purchase_order_id: po.id,
          receipt_number: grnNumber,
          receipt_date: new Date().toISOString().split("T")[0],
          received_by: user.id,
          warehouse_id: warehouseId,
          status: "pending",
          notes: notes || null,
        })
        .select()
        .single();
      if (receiptError) throw receiptError;

      // Phase A.5 — for serial-tracked lines, split into N single-qty rows
      // so `enforce_serial_on_movement` upserts one stock_serial per unit.
      const receiptItems = linesToReceive.flatMap((line, idx) => {
        const isSerial =
          !!line.product_id && getTrackingFlags(line.product_id).is_serial_tracked;
        const base = {
          goods_receipt_id: receipt.id,
          purchase_order_item_id: line.po_item_id || null,
          product_id: line.product_id,
          description: line.description,
          quantity_ordered: line.quantity_ordered,
          lot_number: line.lot_number || null,
          notes: line.notes || null,
          packaging_id: line.packaging_id,
          display_uom_id: line.display_uom_id,
          display_quantity: line.display_quantity,
        };
        if (isSerial) {
          const serials = (line.serial_numbers ?? [])
            .map((s) => s.trim())
            .filter(Boolean);
          return serials.map((sn, subIdx) => ({
            ...base,
            quantity_received: 1,
            serial_number: sn,
            sort_order: idx * 1000 + subIdx,
          }));
        }
        return [
          {
            ...base,
            quantity_received: line.quantity_to_receive,
            serial_number: line.serial_number || null,
            sort_order: idx,
          },
        ];
      });
      const { data: insertedItems, error: itemsError } = await supabase
        .from("goods_receipt_items")
        .insert(receiptItems)
        .select("id, purchase_order_item_id, product_id, quantity_received");
      if (itemsError) throw itemsError;

      const { data: rpcRes, error: rpcErr } = await supabase.rpc(
        "complete_goods_receipt_atomic",
        { p_grn_id: receipt.id, p_user_id: user.id },
      );
      if (rpcErr) throw rpcErr;
      const result = rpcRes as any;
      if (!result?.success) {
        throw new Error(result?.error || "Failed to complete goods receipt");
      }

      // Phase H+ — persist GS1-captured AI 17 / AI 11 dates onto the
      // stock_lots row that the atomic RPC just materialised. Keyed by
      // (business_id, product_id, lot_number). Non-fatal on failure —
      // FEFO simply falls back to receipt-date ordering for this batch.
      const bizId = currentBusiness?.id;
      if (bizId) {
        const dateLines = linesToReceive.filter(
          (l) =>
            l.product_id &&
            l.lot_number &&
            (l.captured_expiry_date || l.captured_manufacture_date),
        );
        for (const l of dateLines) {
          const patch: Record<string, string> = {};
          if (l.captured_expiry_date) patch.expiry_date = l.captured_expiry_date;
          if (l.captured_manufacture_date)
            patch.manufacture_date = l.captured_manufacture_date;
          const { error: lotErr } = await supabase
            .from("stock_lots")
            .update(patch)
            .eq("business_id", bizId)
            .eq("product_id", l.product_id!)
            .eq("lot_number", l.lot_number);
          if (lotErr) {
            console.warn("[GRN] stock_lots date update failed", lotErr);
          }
        }
      }



      // Phase D.2 · ASN reconciliation: transition shipment + log discrepancies
      if (activeShipment) {
        const itemIdByPoItem: Record<string, string> = {};
        for (const row of insertedItems ?? []) {
          if (row.purchase_order_item_id) itemIdByPoItem[row.purchase_order_item_id] = row.id;
        }
        const discrepancies: any[] = [];
        for (const line of linesToReceive) {
          if (!line.inbound_shipment_item_id || line.expected_quantity == null) continue;
          const received = Number(line.quantity_to_receive) || 0;
          const expected = Number(line.expected_quantity) || 0;
          if (received === expected) continue;
          const dtype = received < expected ? "short" : "over";
          discrepancies.push({
            organization_id: currentOrg.id,
            business_id: currentBusiness?.id || wh.business_id,
            branch_id: wh.branch_id,
            goods_receipt_id: receipt.id,
            goods_receipt_item_id: itemIdByPoItem[line.po_item_id] ?? null,
            inbound_shipment_item_id: line.inbound_shipment_item_id,
            product_id: line.product_id,
            expected_quantity: expected,
            received_quantity: received,
            discrepancy_type: dtype,
            resolution: "pending",
            created_by: user.id,
            notes: `Auto-logged from ASN ${activeShipment.shipment_number}`,
          });
        }
        if (discrepancies.length > 0) {
          const { error: discErr } = await supabase
            .from("goods_receipt_discrepancies")
            .insert(discrepancies);
          if (discErr) {
            console.error("Failed to log ASN discrepancies:", discErr);
          }
        }
        const { error: shipErr } = await supabase
          .from("inbound_shipments")
          .update({ status: "received", received_at: new Date().toISOString() })
          .eq("id", activeShipment.id);
        if (shipErr) {
          console.error("Failed to transition ASN to received:", shipErr);
        }
      }


      await supabase.from("audit_logs").insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        user_id: user.id,
        action: "created",
        entity_type: "purchase_order",
        entity_id: po.id,
        entity_name: po.po_number,
        changes_summary: `Goods receipt ${grnNumber} created for PO ${po.po_number}. ${result.movements_created} movement(s), GL ${result.gl_posted ? "posted" : "skipped"}.`,
      });

      // Phase 6 — bind the GRN to a scheduled dock appointment when the
      // user picked one. Non-fatal: the receipt stands even if binding
      // fails (e.g. appointment cancelled between load and submit).
      if (appointmentId) {
        const { error: bindErr } = await supabase.rpc("bind_goods_receipt_appointment", {
          p_receipt_id: receipt.id,
          p_appointment_id: appointmentId,
        });
        if (bindErr) {
          console.warn("[GRN] appointment binding failed", bindErr);
        }
      }

      toast({
        title: "Goods received successfully",
        description: `Receipt ${grnNumber} — ${
          result.po_status === "received" ? "PO fully received" : "Partial receipt recorded"
        }.`,
      });
      navigate(`/purchases/orders/${po.id}`);
    } catch (error: any) {
      console.error("Error creating goods receipt:", error);
      toast({
        title: "Error receiving goods",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <WizardShell
        header={<RecordHeader eyebrow="Goods receipt" title="Loading…" />}
        stepper={<WizardStepper steps={STEPS} activeStepId={activeStep} />}
      >
        <Section>
          <LoadingState />
        </Section>
      </WizardShell>
    );
  }

  if (loadError || !po) {
    return (
      <WizardShell
        header={<RecordHeader eyebrow="Goods receipt" title="Receive goods" />}
        stepper={<WizardStepper steps={STEPS} activeStepId={activeStep} />}
      >
        <Section>
          <ErrorState
            title="Cannot start goods receipt"
            description={loadError ?? "Unknown error."}
            onRetry={() => navigate("/purchases/orders")}
          />
        </Section>
      </WizardShell>
    );
  }

  const setupValid = !!warehouseId;
  const receiveValid = totalToReceive > 0 && !serialCaptureIncomplete;

  const nextDisabled =
    (activeStep === "setup" && !setupValid) ||
    (activeStep === "receive" && !receiveValid);

  const handleNext = () => {
    if (activeStep === "setup") goToStep("receive");
    else if (activeStep === "receive") goToStep("confirm");
  };
  const handleBack = () => {
    if (activeStep === "receive") goToStep("setup");
    else if (activeStep === "confirm") goToStep("receive");
    else navigate(`/purchases/orders/${po.id}`);
  };

  return (
    <WizardShell
      header={
        <RecordHeader
          eyebrow="Goods receipt"
          title={`Receive goods — ${po.po_number}`}
          meta={
            <>
              <span>Vendor: {po.vendor?.name ?? "—"}</span>
              <span>Currency {po.currency}</span>
            </>
          }
          actions={
            <ActionBar>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/purchases/orders/${po.id}`)}
              >
                <ArrowLeft className="mr-2 h-4 w-4" /> Back to PO
              </Button>
            </ActionBar>
          }
        />
      }
      stepper={
        <WizardStepper
          steps={STEPS}
          activeStepId={activeStep}
          completedStepIds={completedStepIds}
          onStepClick={(id) => goToStep(id as StepId)}
        />
      }
      footer={
        <FooterActionBar
          leading={
            <Button variant="ghost" onClick={() => navigate(`/purchases/orders/${po.id}`)}>
              Cancel
            </Button>
          }
          trailing={
            <>
              <Button variant="outline" onClick={handleBack} disabled={isSubmitting}>
                Back
              </Button>
              {activeStep !== "confirm" ? (
                <Button onClick={handleNext} disabled={nextDisabled}>
                  Next
                </Button>
              ) : (
                <Button onClick={handleSubmit} disabled={isSubmitting || totalToReceive === 0}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Posting…
                    </>
                  ) : (
                    <>
                      <Package className="mr-2 h-4 w-4" /> Confirm receipt ({totalToReceive})
                    </>
                  )}
                </Button>
              )}
            </>
          }
        />
      }
    >
      {activeStep === "setup" && (
        <Section title="Destination & context" description="Choose where the goods are being received and add any handover notes.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="grn-warehouse">Destination warehouse</Label>
              <Select value={warehouseId} onValueChange={setWarehouseId}>
                <SelectTrigger id="grn-warehouse">
                  <SelectValue placeholder="Select a warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {(warehouses ?? []).map((w: any) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="grn-notes">Receipt notes</Label>
              <Textarea
                id="grn-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add any notes about this delivery…"
                rows={3}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="grn-appointment">Dock appointment (optional)</Label>
              <Select value={appointmentId || "none"} onValueChange={(v) => setAppointmentId(v === "none" ? "" : v)}>
                <SelectTrigger id="grn-appointment">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {appointments.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.dock_code ? `${a.dock_code} · ` : ""}
                      {new Date(a.window_start).toLocaleString()} · {a.reference ?? a.state}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Bind this GRN to a scheduled inbound slot.</p>
            </div>
          </div>
        </Section>
      )}

      {activeStep === "receive" && (
        <>
          <Section
            title="Scan or enter quantities"
            description="Scan a barcode to receive +1 of that line, or edit the numeric fields directly."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <ScannerPairingButton
                  businessId={currentBusiness?.id}
                  branchId={currentBranch?.id ?? null}
                  label="Goods receipt"
                />
                <Button type="button" variant="outline" size="sm" onClick={handleReceiveAll}>
                  <CheckCircle2 className="mr-2 h-4 w-4" /> Receive all
                </Button>
              </div>
            }
          >
            <div className="space-y-3">
              {activeShipment && (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">ASN</Badge>
                    <span className="font-medium">{activeShipment.shipment_number}</span>
                    <Badge variant="outline" className="text-xs capitalize">
                      {activeShipment.status.replace("_", " ")}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Quantities and lot numbers prefilled from the shipment. Adjust any line where the physical delivery differs — over/short quantities are logged as discrepancies on post.
                  </p>
                </div>
              )}
              <BarcodeInputField
                value={scanCode}
                onChange={setScanCode}
                onScan={handleScanReceive}
                businessId={currentBusiness?.id}
                branchId={currentBranch?.id ?? null}
                allowRepeats
                workflow="receive"
                fieldLabel="Goods receipt"
                placeholder="Scan a barcode to receive +1 of that line"
              />
              {scanFlash && (
                <p className="text-xs text-muted-foreground">{scanFlash}</p>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[30%]">Item</TableHead>
                    <TableHead className="text-center">Ordered</TableHead>
                    <TableHead className="text-center">Previously received</TableHead>
                    <TableHead className="text-center">Receive now</TableHead>
                    <TableHead>Pack</TableHead>
                    <TableHead>Lot #</TableHead>
                    <TableHead>Serial numbers</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receiptLines.map((line, index) => {
                    const maxReceivable =
                      line.quantity_ordered - line.quantity_previously_received;
                    const isFullyReceived =
                      line.quantity_previously_received >= line.quantity_ordered;
                    const trackingFlags = line.product_id
                      ? getTrackingFlags(line.product_id)
                      : { is_lot_tracked: false, is_expiry_tracked: false, is_serial_tracked: false };
                    const requiredSerials = trackingFlags.is_serial_tracked
                      ? Math.round(line.quantity_to_receive)
                      : 0;
                    const enteredSerials = (line.serial_numbers ?? [])
                      .map((s) => s.trim())
                      .filter(Boolean);
                    const uniqueSerials = new Set(enteredSerials);
                    const serialsValid =
                      !trackingFlags.is_serial_tracked ||
                      (enteredSerials.length === requiredSerials &&
                        uniqueSerials.size === enteredSerials.length);
                    return (
                      <TableRow key={index} className={isFullyReceived ? "opacity-50" : ""}>
                        <TableCell>
                          <div className="font-medium">{line.description}</div>
                          {isFullyReceived && (
                            <Badge variant="default" className="mt-1 text-xs">
                              Fully received
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-center">{line.quantity_ordered}</TableCell>
                        <TableCell className="text-center">
                          {line.quantity_previously_received}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={0}
                            max={maxReceivable}
                            value={line.quantity_to_receive}
                            onChange={(e) =>
                              updateLine(
                                index,
                                "quantity_to_receive",
                                Math.min(parseFloat(e.target.value) || 0, maxReceivable),
                              )
                            }
                            disabled={isFullyReceived}
                            className="mx-auto w-20 text-center"
                          />
                        </TableCell>
                        <TableCell>
                          <PackagingSelect
                            productId={line.product_id}
                            value={line.packaging_id}
                            onChange={(packId) => updateLine(index, "packaging_id", packId)}
                            disabled={isFullyReceived}
                            hideWhenEmpty
                            className="w-32"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            placeholder="Lot/Batch"
                            value={line.lot_number}
                            onChange={(e) => updateLine(index, "lot_number", e.target.value)}
                            disabled={isFullyReceived}
                            className="w-28"
                          />
                        </TableCell>
                        <TableCell>
                          {trackingFlags.is_serial_tracked ? (
                            <div className="space-y-1">
                              <Textarea
                                placeholder={`One serial per line (${requiredSerials} required)`}
                                value={(line.serial_numbers ?? []).join("\n")}
                                onChange={(e) =>
                                  updateLine(
                                    index,
                                    "serial_numbers",
                                    e.target.value.split(/\r?\n/),
                                  )
                                }
                                disabled={isFullyReceived || requiredSerials <= 0}
                                className="min-h-[64px] w-56 font-mono text-xs"
                              />
                              <div
                                className={
                                  "text-[10px] tabular-nums " +
                                  (serialsValid
                                    ? "text-muted-foreground"
                                    : "text-destructive")
                                }
                              >
                                {enteredSerials.length}/{requiredSerials} entered
                                {uniqueSerials.size !== enteredSerials.length &&
                                  " · duplicates"}
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Section>
        </>
      )}

      {activeStep === "confirm" && (
        <Section title="Review & post" description="Confirm the receipt below to post stock movements and inventory GL entries.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Warehouse</p>
              <p className="mt-0.5 text-sm">
                {(warehouses ?? []).find((w: any) => w.id === warehouseId)?.name ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Total units to receive</p>
              <p className="mt-0.5 text-sm tabular-nums">{totalToReceive}</p>
            </div>
            {notes && (
              <div className="sm:col-span-2">
                <p className="text-xs font-medium text-muted-foreground">Notes</p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm">{notes}</p>
              </div>
            )}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-center">Receive now</TableHead>
                <TableHead>Lot #</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receiptLines
                .filter((l) => l.quantity_to_receive > 0)
                .map((l, idx) => (
                  <TableRow key={idx}>
                    <TableCell>{l.description}</TableCell>
                    <TableCell className="text-center tabular-nums">
                      {l.quantity_to_receive}
                    </TableCell>
                    <TableCell>{l.lot_number || "—"}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </Section>
      )}
    </WizardShell>
  );
}