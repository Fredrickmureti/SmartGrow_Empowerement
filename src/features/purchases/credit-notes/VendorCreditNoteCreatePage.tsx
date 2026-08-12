/**
 * VendorCreditNoteCreatePage — `/purchases/credit-notes/new`.
 *
 * Enterprise UX Standardization: replaces the inline dialog on
 * `src/pages/VendorCreditNotes.tsx` with a full RecordFormShell page.
 *
 * ADR 0132: the number is minted by `create_vendor_credit_note_atomic` and the
 * form never proposes one; provenance (origin / reason / upstream document /
 * supplier paper) is captured here because the writer refuses to let it be
 * back-filled afterwards.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
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
import { VendorCreditNoteLineageFields } from "./VendorCreditNoteLineageFields";
import { usePurchasableVendors } from "@/features/purchases/suppliers/usePurchasableVendors";
import {
  VendorCreditNoteTotalsPreview,
  computeVendorCreditNoteTotals,
} from "./VendorCreditNoteTotalsPreview";
import {
  emptyLineage,
  lineageError,
  toLineagePayload,
  type LineageFormState,
} from "./vendorCreditNoteLineage";

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
  const { createVendorCreditNote } = useVendorCreditNotes();
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
    vendor_id: "",
    bill_id: "",
    credit_date: new Date().toISOString().split("T")[0],
    notes: "",
    currency: baseCurrency,
  });
  const [lineage, setLineage] = useState<LineageFormState>(emptyLineage);
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine(0)]);

  const patchLineage = useCallback(
    (patch: Partial<LineageFormState>) => setLineage((p) => ({ ...p, ...patch })),
    [],
  );

  const vendors = usePurchasableVendors(contacts);
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

  const totals = useMemo(() => computeVendorCreditNoteTotals(lineItems), [lineItems]);

  const billId =
    formData.bill_id && formData.bill_id !== "__none__" ? formData.bill_id : null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.vendor_id || lineItems.every((item) => !item.description)) {
      toast.error("Please fill required fields");
      return;
    }
    const provenanceError = lineageError(lineage, billId);
    if (provenanceError) {
      toast.error(provenanceError);
      return;
    }
    setIsSubmitting(true);
    try {
      await createVendorCreditNote(
        {
          vendor_id: formData.vendor_id || null,
          bill_id: billId,
          status: "draft",
          credit_date: formData.credit_date,
          subtotal: totals.subtotal,
          tax_amount: totals.taxTotal,
          total: totals.grandTotal,
          amount_applied: 0,
          currency: formData.currency || baseCurrency,
          notes: formData.notes || null,
          journal_entry_id: null,
        } as any,
        lineItems,
        requestIdRef.current,
        toLineagePayload(lineage),
      );

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
            <Label>Credit Note #</Label>
            <Input value="Assigned on save" disabled readOnly />
            <p className="text-xs text-muted-foreground">
              Numbering is server-controlled and gap-free.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Supplier *</Label>
            <Select
              value={formData.vendor_id}
              onValueChange={(v) =>
                setFormData((p) => ({ ...p, vendor_id: v, bill_id: "" }))
              }
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
              value={formData.bill_id || "__none__"}
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

      <FieldGroup label="Provenance">
        <VendorCreditNoteLineageFields
          value={lineage}
          onChange={patchLineage}
          vendorId={formData.vendor_id}
          disabled={isSubmitting}
        />
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
            <VendorCreditNoteTotalsPreview
              totals={totals}
              formatCurrency={formatLineCurrency}
            />
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
