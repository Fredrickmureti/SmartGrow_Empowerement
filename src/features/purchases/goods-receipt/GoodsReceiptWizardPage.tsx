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

  const handleScanReceive = async (code: string) => {
    const norm = code.trim();
    if (!norm) return;
    setScanCode("");
    const resolved = await resolveTagged(norm);
    let idx = -1;
    let qtyDelta = 1;
    if (resolved.kind === "hit") {
      qtyDelta = Math.max(1, Math.round(resolved.row.scanQuantity || 1));
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
    setScanFlash(`+${qtyDelta} ${receiptLines[idx].description} (now ${next})`);
    window.setTimeout(() => setScanFlash(null), 1500);
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

      const receiptItems = linesToReceive.map((line, idx) => ({
        goods_receipt_id: receipt.id,
        purchase_order_item_id: line.po_item_id || null,
        product_id: line.product_id,
        description: line.description,
        quantity_ordered: line.quantity_ordered,
        quantity_received: line.quantity_to_receive,
        lot_number: line.lot_number || null,
        serial_number: line.serial_number || null,
        notes: line.notes || null,
        sort_order: idx,
        packaging_id: line.packaging_id,
        display_uom_id: line.display_uom_id,
        display_quantity: line.display_quantity,
      }));
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
  const receiveValid = totalToReceive > 0;

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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receiptLines.map((line, index) => {
                    const maxReceivable =
                      line.quantity_ordered - line.quantity_previously_received;
                    const isFullyReceived =
                      line.quantity_previously_received >= line.quantity_ordered;
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