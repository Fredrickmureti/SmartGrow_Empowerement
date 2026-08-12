/**
 * PurchaseReturnCreatePage — `/purchases/returns/new`.
 *
 * Returns are never authored by typing. A goods return is picked from the
 * goods receipt that brought the stock in: the receipt line carries the landed
 * cost, the lot/serial, the packaging provenance, the warehouse and the
 * remaining-returnable quantity (`purchase_return_returnable_lines`). The
 * server prices goods lines from that receipt and rejects a quantity above
 * what is still returnable, so this screen's job is to make the choice
 * legible — not to compute the money.
 *
 * A `financial` return is the off-receipt path (price/billing dispute with no
 * goods movement). It is explicitly labelled as such because it produces a
 * debit note without a stock movement.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, PackageCheck } from "lucide-react";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { NumericInput } from "@/components/ui/numeric-input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useBusinesses } from "@/hooks/useBusinesses";
import { useContacts } from "@/hooks/useContacts";
import { usePurchasableVendors } from "../suppliers/usePurchasableVendors";
import { useCurrency } from "@/hooks/useCurrency";
import { normalizeError } from "@/services/resilience";
import {
  createPurchaseReturn,
  PURCHASE_RETURN_REASON_CODES,
  type PurchaseReturnKind,
  type PurchaseReturnLineInput,
} from "@/lib/purchases/purchaseReturnRpcs";
import {
  useReturnableReceipts,
  useReturnableReceiptLines,
} from "./useReturnableReceipts";

interface PickedLine {
  selected: boolean;
  quantity: number;
  condition: string;
  return_reason: string;
}

const CONDITIONS = ["damaged", "defective", "unopened", "expired", "other"];

export default function PurchaseReturnCreatePage() {
  const navigate = useNavigate();
  const { currentBusiness } = useBusinesses();
  const { contacts } = useContacts();
  const { formatCurrency, baseCurrency } = useCurrency();

  const [returnKind, setReturnKind] = useState<PurchaseReturnKind>("goods");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [returnDate, setReturnDate] = useState(new Date().toISOString().split("T")[0]);
  const [reasonCode, setReasonCode] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [picked, setPicked] = useState<Record<string, PickedLine>>({});
  // Financial adjustment: a single valued line, no goods, no receipt.
  const [adjustDescription, setAdjustDescription] = useState("");
  const [adjustAmount, setAdjustAmount] = useState(0);

  // Canonical gate: suspended / blocked / archived supplier roles are not
  // offered; trg_purchase_returns_supplier_purchasable enforces it server-side.
  const vendors = usePurchasableVendors(contacts as any) as typeof contacts;

  const { receipts, loading: receiptsLoading } = useReturnableReceipts(vendorId || null);
  const { lines, loading: linesLoading, error: linesError } = useReturnableReceiptLines(
    returnKind === "goods" ? receiptId || null : null,
  );

  const selectedReceipt = receipts.find((r) => r.id === receiptId) ?? null;

  // Picking the receipt is what decides the supplier — a return cannot address
  // a different vendor than the one that delivered.
  useEffect(() => {
    if (selectedReceipt?.vendor_id && selectedReceipt.vendor_id !== vendorId) {
      setVendorId(selectedReceipt.vendor_id);
    }
  }, [selectedReceipt?.vendor_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPicked({});
  }, [receiptId]);

  const patch = useCallback((id: string, next: Partial<PickedLine>) => {
    setPicked((prev) => ({
      ...prev,
      [id]: {
        selected: false,
        quantity: 0,
        condition: "",
        return_reason: "",
        ...prev[id],
        ...next,
      },
    }));
  }, []);

  const toggleLine = useCallback(
    (id: string, returnable: number, on: boolean) =>
      patch(id, { selected: on, quantity: on ? returnable : 0 }),
    [patch],
  );

  const selectedLines = lines.filter((l) => picked[l.goods_receipt_item_id]?.selected);
  const goodsTotal = selectedLines.reduce(
    (sum, l) => sum + (picked[l.goods_receipt_item_id]?.quantity ?? 0) * l.unit_cost,
    0,
  );
  const estimatedTotal = returnKind === "goods" ? goodsTotal : adjustAmount;

  const canSubmit =
    !!currentBusiness?.id &&
    !!vendorId &&
    !!reasonCode &&
    (returnKind === "goods"
      ? !!receiptId && selectedLines.length > 0 && selectedLines.every(
          (l) => (picked[l.goods_receipt_item_id]?.quantity ?? 0) > 0,
        )
      : adjustAmount > 0 && adjustDescription.trim().length > 0);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !currentBusiness?.id) {
      toast.error("Pick a supplier, a reason and at least one line to return");
      return;
    }
    setIsSubmitting(true);
    try {
      const payload: PurchaseReturnLineInput[] =
        returnKind === "goods"
          ? selectedLines.map((l) => {
              const p = picked[l.goods_receipt_item_id];
              return {
                goods_receipt_item_id: l.goods_receipt_item_id,
                quantity: p.quantity,
                condition: p.condition || null,
                return_reason: p.return_reason || null,
              };
            })
          : [
              {
                description: adjustDescription.trim(),
                quantity: 1,
                unit_price: adjustAmount,
              },
            ];

      const created = await createPurchaseReturn({
        businessId: currentBusiness.id,
        vendorId,
        lines: payload,
        returnKind,
        goodsReceiptId: returnKind === "goods" ? receiptId : null,
        warehouseId: returnKind === "goods" ? selectedReceipt?.warehouse_id ?? null : null,
        returnDate,
        reasonCode,
        reason: reason || null,
        notes: notes || null,
      });
      toast.success(`Purchase return ${created.return_number} created as draft`);
      navigate(`/purchases/returns/${created.id}`);
    } catch (err) {
      toast.error(normalizeError(err).message || "Failed to create return");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Purchase Return"
      meta="Return received goods to a supplier, or raise a financial adjustment"
      cancelHref="/purchases/returns"
      onSubmit={onSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!canSubmit}
      submitLabel="Create draft return"
    >
      <FieldGroup label="What are you returning?">
        <Tabs
          value={returnKind}
          onValueChange={(v) => setReturnKind(v as PurchaseReturnKind)}
        >
          <TabsList>
            <TabsTrigger value="goods">Goods from a receipt</TabsTrigger>
            <TabsTrigger value="financial">Financial adjustment</TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="mt-2 text-xs text-muted-foreground">
          {returnKind === "goods"
            ? "Lines are picked from the goods receipt, priced at the receipt's landed cost, and stock only leaves the warehouse when the return is dispatched."
            : "No goods move. This raises a valued debit note against the supplier — use it for price or billing disputes."}
        </p>
      </FieldGroup>

      <FieldGroup label="Return details">
        <FieldGrid columns={2}>
          {returnKind === "goods" ? (
            <FieldCell span={2}>
              <div className="space-y-2">
                <Label>Goods receipt *</Label>
                <Select value={receiptId} onValueChange={setReceiptId}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        receiptsLoading ? "Loading receipts…" : "Select the receipt the goods came in on"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {receipts.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.receipt_number} — {r.vendor_name ?? "Unknown supplier"} · {r.receipt_date}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!receiptsLoading && receipts.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No goods receipts in this company yet. Receive a purchase order first —
                    a goods return must reference the receipt it came from.
                  </p>
                )}
              </div>
            </FieldCell>
          ) : null}

          <div className="space-y-2">
            <Label>Supplier *</Label>
            <Select
              value={vendorId}
              onValueChange={setVendorId}
              disabled={returnKind === "goods" && !!selectedReceipt?.vendor_id}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select supplier" />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {returnKind === "goods" && selectedReceipt?.vendor_id && (
              <p className="text-xs text-muted-foreground">
                Taken from the receipt — a return addresses the supplier that delivered.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Return date</Label>
            <Input
              type="date"
              value={returnDate}
              onChange={(e) => setReturnDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Reason code *</Label>
            <Select value={reasonCode} onValueChange={setReasonCode}>
              <SelectTrigger>
                <SelectValue placeholder="Why is this going back?" />
              </SelectTrigger>
              <SelectContent>
                {PURCHASE_RETURN_REASON_CODES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Reason detail</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional free-text detail"
            />
          </div>
        </FieldGrid>
      </FieldGroup>

      {returnKind === "goods" ? (
        <FieldGroup label="Lines to return">
          {!receiptId ? (
            <p className="text-sm text-muted-foreground">
              Select a goods receipt to see what can still be returned.
            </p>
          ) : linesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading receipt lines…
            </div>
          ) : linesError ? (
            <p className="text-sm text-destructive">{linesError}</p>
          ) : lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">This receipt has no lines.</p>
          ) : (
            <div className="space-y-2">
              {lines.map((l) => {
                const p = picked[l.goods_receipt_item_id];
                const exhausted = l.quantity_returnable <= 0;
                return (
                  <Card key={l.goods_receipt_item_id} className={exhausted ? "opacity-60" : ""}>
                    <CardContent className="flex flex-wrap items-center gap-3 p-3">
                      <Checkbox
                        checked={!!p?.selected}
                        disabled={exhausted}
                        onCheckedChange={(v) =>
                          toggleLine(l.goods_receipt_item_id, l.quantity_returnable, v === true)
                        }
                      />
                      <div className="min-w-[180px] flex-1">
                        <div className="text-sm font-medium">{l.description}</div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>
                            Received {l.quantity_received}
                            {l.uom_snapshot ? ` ${l.uom_snapshot}` : ""}
                          </span>
                          <span>Returned {l.quantity_returned}</span>
                          <span>Returnable {l.quantity_returnable}</span>
                          <span>@ {formatCurrency(l.unit_cost, baseCurrency)}</span>
                          {l.lot_number && <Badge variant="outline">Lot {l.lot_number}</Badge>}
                          {l.serial_number && (
                            <Badge variant="outline">S/N {l.serial_number}</Badge>
                          )}
                          {exhausted && <Badge variant="secondary">Fully returned</Badge>}
                        </div>
                      </div>
                      <div className="w-24 space-y-1">
                        <Label className="text-xs">Qty</Label>
                        <NumericInput
                          value={p?.quantity ?? 0}
                          min={0}
                          max={l.quantity_returnable}
                          disabled={!p?.selected}
                          onValueChange={(v) =>
                            patch(l.goods_receipt_item_id, {
                              quantity: Math.min(Number(v) || 0, l.quantity_returnable),
                            })
                          }
                        />
                      </div>
                      <div className="w-36 space-y-1">
                        <Label className="text-xs">Condition</Label>
                        <Select
                          value={p?.condition ?? ""}
                          disabled={!p?.selected}
                          onValueChange={(v) => patch(l.goods_receipt_item_id, { condition: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="—" />
                          </SelectTrigger>
                          <SelectContent>
                            {CONDITIONS.map((c) => (
                              <SelectItem key={c} value={c}>
                                {c}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="w-40 space-y-1">
                        <Label className="text-xs">Line note</Label>
                        <Input
                          value={p?.return_reason ?? ""}
                          disabled={!p?.selected}
                          onChange={(e) =>
                            patch(l.goods_receipt_item_id, { return_reason: e.target.value })
                          }
                        />
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </FieldGroup>
      ) : (
        <FieldGroup label="Adjustment">
          <FieldGrid columns={2}>
            <FieldCell span={2}>
              <div className="space-y-2">
                <Label>What is being debited? *</Label>
                <Input
                  value={adjustDescription}
                  onChange={(e) => setAdjustDescription(e.target.value)}
                  placeholder="e.g. Overcharged freight on bill BILL-2026-0031"
                />
              </div>
            </FieldCell>
            <div className="space-y-2">
              <Label>Amount *</Label>
              <NumericInput
                value={adjustAmount}
                min={0}
                onValueChange={(v) => setAdjustAmount(Number(v) || 0)}
              />
            </div>
          </FieldGrid>
        </FieldGroup>
      )}

      <FieldGroup label="Notes">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Additional notes for the supplier or the approver"
        />
      </FieldGroup>

      <div className="flex items-center justify-end gap-2 text-sm">
        <PackageCheck className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">Estimated value</span>
        <span className="text-lg font-semibold tabular-nums">
          {formatCurrency(estimatedTotal, baseCurrency)}
        </span>
      </div>
      <p className="text-right text-xs text-muted-foreground">
        The server prices and totals the return from the receipt — this figure is an estimate.
      </p>
    </RecordFormShell>
  );
}
