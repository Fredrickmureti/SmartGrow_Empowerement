/**
 * VendorCreditNoteCreatePage — `/purchases/credit-notes/new`.
 *
 * Enterprise UX Standardization: replaces the inline dialog on
 * `src/pages/VendorCreditNotes.tsx` with a full RecordFormShell page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
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

export default function VendorCreditNoteCreatePage() {
  const navigate = useNavigate();
  const { getNextCreditNoteNumber, createVendorCreditNote } = useVendorCreditNotes();
  const { contacts } = useContacts();
  const { bills } = useBills();
  const { formatCurrency, baseCurrency } = useCurrency();

  const [isSubmitting, setIsSubmitting] = useState(false);
  // One deterministic intent key per create attempt. A retry or a double
  // submit replays the same server-side creation instead of duplicating it.
  const requestIdRef = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `vcn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

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
    (async () => {
      try {
        const nextNum = await getNextCreditNoteNumber();
        setFormData((p) => ({ ...p, credit_note_number: nextNum }));
      } catch (e) {
        // number generation is best-effort; keep manual entry as fallback
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (!formData.vendor_id || lineItems.every((item) => !item.description)) {
      toast.error("Please fill required fields");
      return;
    }
    setIsSubmitting(true);
    try {
      const created = await createVendorCreditNote(
        {
          credit_note_number: formData.credit_note_number,
          vendor_id: formData.vendor_id || null,
          bill_id:
            formData.bill_id && formData.bill_id !== "__none__" ? formData.bill_id : null,
          status: "draft",
          credit_date: formData.credit_date,
          subtotal,
          tax_amount: taxTotal,
          total: grandTotal,
          amount_applied: 0,
          currency: formData.currency || baseCurrency,
          notes: formData.notes || null,
          journal_entry_id: null,
        } as any,
        lineItems,
        requestIdRef.current,
      );

      toast.success("Credit note created");
      navigate("/purchases/credit-notes");
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to create credit note");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Credit Note"
      meta="Record a credit received from a supplier"
      cancelHref="/purchases/credit-notes"
      onSubmit={onSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!formData.vendor_id}
      submitLabel="Create Credit Note"
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
              onChange={(e) => setFormData({ ...formData, credit_date: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Linked Bill (optional)</Label>
            <Select
              value={formData.bill_id}
              onValueChange={(v) => setFormData({ ...formData, bill_id: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select bill" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {outstandingBills
                  .filter((b) => !formData.vendor_id || b.vendor_id === formData.vendor_id)
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