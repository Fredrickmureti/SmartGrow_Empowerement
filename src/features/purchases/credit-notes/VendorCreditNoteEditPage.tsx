/**
 * VendorCreditNoteEditPage — `/purchases/credit-notes/:id/edit`.
 *
 * Enterprise UX Standardization (Phase A1): pairs the existing
 * VendorCreditNoteCreatePage so every VCN business record has a full
 * `/new` + `/:id/edit` route on top of RecordFormShell. Only draft
 * credit notes are editable — the underlying hook enforces this.
 *
 * ADR 0132: the number stays server-owned (read-only here). Origin, reason
 * code and the supplier's own document reference remain correctable while the
 * note is a draft; upstream references (return / GRN / PO) are stamped by the
 * create writer and are therefore shown, not re-pointed.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { ErrorState, LoadingState } from "@/design-system";
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

  useEffect(() => {
    if (!cn || primed) return;
    setFormData({
      vendor_id: cn.vendor_id ?? "",
      bill_id: cn.bill_id ?? "",
      credit_date: cn.credit_date,
      notes: cn.notes ?? "",
      currency: cn.currency || baseCurrency,
    });
    setLineage({
      origin: cn.origin ?? "adjustment",
      reason_code: cn.reason_code ?? "",
      vendor_document_number: cn.vendor_document_number ?? "",
      vendor_document_date: cn.vendor_document_date ?? "",
      source_return_id: cn.source_return_id ?? "",
      goods_receipt_id: cn.goods_receipt_id ?? "",
      purchase_order_id: cn.purchase_order_id ?? "",
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

  const totals = useMemo(() => computeVendorCreditNoteTotals(lineItems), [lineItems]);

  const billId =
    formData.bill_id && formData.bill_id !== "__none__" ? formData.bill_id : null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cn) return;
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
      const payload = toLineagePayload(lineage);
      await updateVendorCreditNote(
        cn.id,
        {
          vendor_id: formData.vendor_id || null,
          bill_id: billId,
          credit_date: formData.credit_date,
          subtotal: totals.subtotal,
          tax_amount: totals.taxTotal,
          total: totals.grandTotal,
          currency: formData.currency || baseCurrency,
          notes: formData.notes || null,
          origin: payload.origin,
          reason_code: payload.reason_code,
          vendor_document_number: payload.vendor_document_number,
          vendor_document_date: payload.vendor_document_date,
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
            <Label>Credit Note #</Label>
            <Input value={cn.credit_note_number} disabled readOnly />
            <p className="text-xs text-muted-foreground">
              Numbering is server-controlled and cannot be changed.
            </p>
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
