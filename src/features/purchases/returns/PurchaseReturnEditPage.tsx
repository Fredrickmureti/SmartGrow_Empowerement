/**
 * PurchaseReturnEditPage — `/purchases/returns/:id/edit`.
 *
 * Only a `draft` return is editable, and only through
 * `purchase_return_update_draft` with the `row_version` we read (optimistic
 * concurrency: a competing edit or a submit in another tab makes this save
 * fail loudly rather than silently overwrite). Once submitted, the document is
 * governed — corrections happen by rejecting or cancelling, never by editing.
 *
 * Receipt provenance (`goods_receipt_item_id`, lot/serial, landed cost) is
 * immutable here: quantities, conditions and header narrative are what a draft
 * amendment can legitimately change. Changing *which* lines go back means
 * cancelling and re-picking from the receipt.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { NumericInput } from "@/components/ui/numeric-input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useCurrency } from "@/hooks/useCurrency";
import { normalizeError } from "@/services/resilience";
import {
  PURCHASE_RETURN_REASON_CODES,
  updatePurchaseReturnDraft,
  type PurchaseReturnLineInput,
} from "@/lib/purchases/purchaseReturnRpcs";
import { usePurchaseReturnRecord } from "./usePurchaseReturnRecord";

export default function PurchaseReturnEditPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency, baseCurrency } = useCurrency();
  const { record, loading, error } = usePurchaseReturnRecord(id);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [returnDate, setReturnDate] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});

  const items = useMemo(
    () =>
      (record?.items ?? [])
        .slice()
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [record],
  );

  useEffect(() => {
    if (!record) return;
    setReturnDate(record.return_date ?? "");
    setReasonCode(record.reason_code ?? "");
    setReason(record.reason ?? "");
    setNotes(record.notes ?? "");
    setQty(
      Object.fromEntries(
        (record.items ?? []).map((l) => [l.id as string, Number(l.quantity) || 0]),
      ),
    );
  }, [record?.id, record?.row_version]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDraft = record?.status === "draft";
  const estimated = items.reduce(
    (sum, l) => sum + (qty[l.id as string] ?? 0) * (Number(l.unit_price) || 0),
    0,
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!record) return;
    const lines: PurchaseReturnLineInput[] = items
      .map((l) => ({
        goods_receipt_item_id: l.goods_receipt_item_id ?? null,
        product_id: l.product_id ?? null,
        description: l.description ?? null,
        quantity: qty[l.id as string] ?? 0,
        unit_price: l.goods_receipt_item_id ? null : Number(l.unit_price) || 0,
        return_reason: l.return_reason ?? null,
        condition: l.condition ?? null,
        lot_number: l.lot_number ?? null,
        serial_number: l.serial_number ?? null,
        location_id: l.location_id ?? null,
      }))
      .filter((l) => l.quantity > 0);

    if (lines.length === 0) {
      toast.error("A return needs at least one line with a quantity");
      return;
    }

    setIsSubmitting(true);
    try {
      await updatePurchaseReturnDraft({
        id: record.id,
        rowVersion: record.row_version,
        lines,
        returnDate: returnDate || null,
        reasonCode: reasonCode || null,
        reason: reason || null,
        notes: notes || null,
      });
      toast.success("Draft return updated");
      navigate(`/purchases/returns/${record.id}`);
    } catch (err) {
      toast.error(normalizeError(err).message || "Failed to update return");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading return…
      </div>
    );
  }

  if (error || !record) {
    return <div className="p-8 text-sm text-destructive">{error ?? "Return not found."}</div>;
  }

  if (!isDraft) {
    return (
      <div className="space-y-2 p-8">
        <h1 className="text-lg font-semibold">{record.return_number} can no longer be edited</h1>
        <p className="text-sm text-muted-foreground">
          This return is <Badge variant="outline">{record.status}</Badge> — once submitted it is
          governed by the approval trail. Reject or cancel it to make changes.
        </p>
      </div>
    );
  }

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Purchase Return"
      recordRef={record.return_number}
      meta={`Draft · ${record.vendor?.name ?? "Supplier"}`}
      cancelHref={`/purchases/returns/${record.id}`}
      onSubmit={onSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Save draft"
    >
      <FieldGroup label="Return details">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Return date</Label>
            <Input
              type="date"
              value={returnDate}
              onChange={(e) => setReturnDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Reason code</Label>
            <Select value={reasonCode} onValueChange={setReasonCode}>
              <SelectTrigger>
                <SelectValue placeholder="Select a reason" />
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
          <FieldCell span={2}>
            <div className="space-y-2">
              <Label>Reason detail</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </FieldCell>
        </FieldGrid>
      </FieldGroup>

      <FieldGroup
        label="Lines"
        description="Quantities only. Product, cost and lot/serial come from the goods receipt and cannot be retyped."
      >
        <div className="space-y-2">
          {items.map((l) => (
            <Card key={l.id}>
              <CardContent className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-[200px] flex-1">
                  <div className="text-sm font-medium">{l.description || "—"}</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>@ {formatCurrency(Number(l.unit_price) || 0, baseCurrency)}</span>
                    {l.goods_receipt_item_id ? (
                      <Badge variant="outline">From receipt</Badge>
                    ) : (
                      <Badge variant="secondary">No receipt basis</Badge>
                    )}
                    {l.lot_number && <Badge variant="outline">Lot {l.lot_number}</Badge>}
                    {l.serial_number && <Badge variant="outline">S/N {l.serial_number}</Badge>}
                    {l.condition && <span>Condition: {l.condition}</span>}
                  </div>
                </div>
                <div className="w-28 space-y-1">
                  <Label className="text-xs">Qty</Label>
                  <NumericInput
                    value={qty[l.id as string] ?? 0}
                    min={0}
                    onValueChange={(v) =>
                      setQty((prev) => ({ ...prev, [l.id as string]: Number(v) || 0 }))
                    }
                  />
                </div>
              </CardContent>
            </Card>
          ))}
          {items.length === 0 && (
            <p className="text-sm text-muted-foreground">This draft has no lines.</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Setting a quantity to zero removes the line. The server re-validates every quantity
          against what is still returnable on the receipt.
        </p>
      </FieldGroup>

      <FieldGroup label="Notes">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </FieldGroup>

      <div className="flex items-center justify-end gap-2 text-sm">
        <span className="text-muted-foreground">Estimated value</span>
        <span className="text-lg font-semibold tabular-nums">
          {formatCurrency(estimated, baseCurrency)}
        </span>
      </div>
    </RecordFormShell>
  );
}
