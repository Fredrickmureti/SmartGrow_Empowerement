// @ts-nocheck
/**
 * VendorCreditNoteEditPage — `/purchases/credit-notes/:id/edit`.
 *
 * Enterprise UX Standardization (Phase A1): pairs the existing
 * VendorCreditNoteCreatePage so every VCN business record has a full
 * `/new` + `/:id/edit` route on top of RecordFormShell. Only draft
 * credit notes are editable — the underlying hook enforces this.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { ErrorState, LoadingState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { PricedLineRow, PRICED_LINE_COLUMNS } from "@/components/documents/lines/PricedLineRow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  useVendorCreditNotes,
  type VendorCreditNoteItem,
} from "@/hooks/useVendorCreditNotes";
import { useContacts } from "@/hooks/useContacts";
import { useBills } from "@/hooks/useBills";
import { useCurrency } from "@/hooks/useCurrency";
import { normalizeError } from "@/services/resilience";

type LineItem = Omit<VendorCreditNoteItem, "id" | "credit_note_id">;

const emptyLine = (sort_order = 0): LineItem => ({
  product_id: null,
  account_id: null,
  description: "",
  quantity: 1,
  unit_price: 0,
  tax_rate: 0,
  tax_amount: 0,
  line_total: 0,
  sort_order,
});

export default function VendorCreditNoteEditPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { creditNotes, isLoading, updateVendorCreditNote } = useVendorCreditNotes();
  const { contacts } = useContacts();
  const { bills } = useBills();
  const { formatCurrency, baseCurrency } = useCurrency();

  const cn = useMemo(
    () => creditNotes.find((c) => c.id === id) ?? null,
    [creditNotes, id],
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [primed, setPrimed] = useState(false);
  const [formData, setFormData] = useState({
    credit_note_number: "",
    vendor_id: "",
    bill_id: "",
    credit_date: new Date().toISOString().split("T")[0],
    notes: "",
    currency: baseCurrency,
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine(0)]);

  useEffect(() => {
    if (!cn || primed) return;
    setFormData({
      credit_note_number: cn.credit_note_number,
      vendor_id: cn.vendor_id ?? "",
      bill_id: cn.bill_id ?? "",
      credit_date: cn.credit_date,
      notes: cn.notes ?? "",
      currency: cn.currency || baseCurrency,
    });
    if (cn.items && cn.items.length > 0) {
      setLineItems(
        cn.items.map((item, idx) => ({
          product_id: item.product_id ?? null,
          account_id: item.account_id ?? null,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate,
          tax_amount: item.tax_amount,
          line_total: item.line_total,
          sort_order: idx,
          packaging_id: item.packaging_id ?? null,
          display_uom_id: item.display_uom_id ?? null,
          display_quantity: item.display_quantity ?? null,
        })),
      );
    }
    setPrimed(true);
  }, [cn, primed, baseCurrency]);

  const vendors = contacts.filter(
    (c) => (c.type === "supplier" || c.type === "both") && c.is_active,
  );
  const outstandingBills = bills.filter((b) =>
    ["received", "partial", "overdue"].includes(b.status),
  );

  const patchLineItem = useCallback((index: number, patch: Partial<LineItem>) => {
    setLineItems((prev) =>
      prev.map((line, i) => {
        if (i !== index) return line;
        const merged = { ...line, ...patch } as LineItem;
        const sub = (Number(merged.quantity) || 0) * (Number(merged.unit_price) || 0);
        const taxAmount = sub * ((Number(merged.tax_rate) || 0) / 100);
        return { ...merged, tax_amount: taxAmount, line_total: sub + taxAmount };
      }),
    );
  }, []);

  const formatLineCurrency = useCallback(
    (n: number) => formatCurrency(n, formData.currency),
    [formatCurrency, formData.currency],
  );

  const addLineItem = useCallback(
    () => setLineItems((prev) => [...prev, emptyLine(prev.length)]),
    [],
  );

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }, []);

  const subtotal = lineItems.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const taxTotal = lineItems.reduce((s, i) => s + i.tax_amount, 0);
  const grandTotal = lineItems.reduce((s, i) => s + i.line_total, 0);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cn) return;
    if (!formData.vendor_id || lineItems.every((item) => !item.description)) {
      toast.error("Please fill required fields");
      return;
    }
    setIsSubmitting(true);
    try {
      await updateVendorCreditNote(
        cn.id,
        {
          credit_note_number: formData.credit_note_number,
          vendor_id: formData.vendor_id || null,
          bill_id:
            formData.bill_id && formData.bill_id !== "__none__"
              ? formData.bill_id
              : null,
          credit_date: formData.credit_date,
          subtotal,
          tax_amount: taxTotal,
          total: grandTotal,
          currency: formData.currency || baseCurrency,
          notes: formData.notes || null,
        } as any,
        lineItems.filter((item) => item.description),
      );
      navigate("/purchases/credit-notes");
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to update credit note");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading && !cn) {
    return (
      <RecordFormShell
        mode="edit"
        entityLabel="Credit Note"
        cancelHref="/purchases/credit-notes"
      >
        <LoadingState />
      </RecordFormShell>
    );
  }

  if (!cn) {
    return (
      <RecordFormShell
        mode="edit"
        entityLabel="Credit Note"
        cancelHref="/purchases/credit-notes"
      >
        <ErrorState
          title="Credit note not found"
          description="It may have been deleted or you don't have access."
          onRetry={() => navigate("/purchases/credit-notes")}
        />
      </RecordFormShell>
    );
  }

  if (cn.status !== "draft") {
    return (
      <RecordFormShell
        mode="edit"
        entityLabel="Credit Note"
        cancelHref="/purchases/credit-notes"
      >
        <ErrorState
          title="Credit note is not editable"
          description={`This credit note is ${cn.status}. Only draft credit notes can be edited.`}
          onRetry={() => navigate("/purchases/credit-notes")}
        />
      </RecordFormShell>
    );
  }

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Credit Note"
      meta={`Edit draft ${cn.credit_note_number}`}
      cancelHref="/purchases/credit-notes"
      onSubmit={onSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!formData.vendor_id}
      submitLabel="Save Changes"
    >
      <FieldGroup label="Credit Note Details">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Credit Note # *</Label>
            <Input
              value={formData.credit_note_number}
              onChange={(e) =>
                setFormData({ ...formData, credit_note_number: e.target.value })
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label>Supplier *</Label>
            <Select
              value={formData.vendor_id}
              onValueChange={(v) => setFormData({ ...formData, vendor_id: v })}
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
          </div>
          <div className="space-y-2">
            <Label>Credit Date</Label>
            <Input
              type="date"
              value={formData.credit_date}
              onChange={(e) =>
                setFormData({ ...formData, credit_date: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Linked Bill (optional)</Label>
            <Select
              value={formData.bill_id || "__none__"}
              onValueChange={(v) => setFormData({ ...formData, bill_id: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select bill" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {outstandingBills
                  .filter(
                    (b) => !formData.vendor_id || b.vendor_id === formData.vendor_id,
                  )
                  .map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.bill_number} —{" "}
                      {formatCurrency(b.total - (b.amount_paid || 0), b.currency)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </FieldGrid>
      </FieldGroup>

      <FieldGroup label="Line Items">
        <EditableLineItemsGrid
          columns={PRICED_LINE_COLUMNS}
          rows={lineItems}
          onAddRow={addLineItem}
          onRemoveRow={removeLineItem}
          addLabel="Add Line"
          disabled={isSubmitting}
          renderRow={(item, idx, layout) => (
            <PricedLineRow
              key={idx}
              index={idx}
              item={item}
              hideProductPicker
              layout={layout}
              disabled={isSubmitting}
              formatCurrency={formatLineCurrency}
              onPatch={patchLineItem}
            />
          )}
          footer={
            <div className="flex justify-end">
              <div className="w-64 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span>Subtotal:</span>
                  <span>{formatCurrency(subtotal, formData.currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Tax:</span>
                  <span>{formatCurrency(taxTotal, formData.currency)}</span>
                </div>
                <div className="flex justify-between font-bold text-lg border-t pt-2">
                  <span>Total:</span>
                  <span>{formatCurrency(grandTotal, formData.currency)}</span>
                </div>
              </div>
            </div>
          }
        />
      </FieldGroup>

      <FieldGroup label="Notes">
        <div className="space-y-2">
          <Textarea
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            placeholder="Optional notes"
          />
        </div>
      </FieldGroup>
    </RecordFormShell>
  );
}
