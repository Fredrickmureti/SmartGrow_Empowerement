// @ts-nocheck
/**
 * CreditNoteCreatePage — `/sales/credit-notes/new`.
 *
 * Phase-3 route replacement for the retired `CreateCreditNoteDialog`.
 * Hosts the same form body on top of `RecordFormShell`.
 *
 * Deep-link params:
 *   ?contact_id=<uuid>   pre-fill customer
 *   ?invoice_id=<uuid>   pre-fill related invoice (auto-loads its items)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useCreditNotes, CreditNoteItem } from "@/hooks/useCreditNotes";
import { useContacts } from "@/hooks/useContacts";
import { useInvoices } from "@/hooks/useInvoices";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { computeLine } from "@/lib/invoiceLineMath";
import { validateLineItems } from "@/lib/validation/lineItems";
import { normalizeError } from "@/services/resilience";
import { format } from "date-fns";
import { OutboundLineTracking } from "@/components/inventory/OutboundLineTracking";
import {
  lotNumberFromAllocations,
  serialNumberFromRows,
} from "@/components/inventory/outboundLineTrackingUtils";

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
import { Separator } from "@/components/ui/separator";
import { Send, Loader2 } from "lucide-react";
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { PricedLineRow, PRICED_LINE_COLUMNS } from "@/components/documents/lines/PricedLineRow";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";

type LineItem = Omit<CreditNoteItem, "id" | "credit_note_id">;

const emptyLine = (sort_order = 0): LineItem => ({
  product_id: null,
  description: "",
  quantity: 1,
  unit_price: 0,
  tax_rate: 0,
  tax_amount: 0,
  line_total: 0,
  sort_order,
});

export default function CreditNoteCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillContactId = searchParams.get("contact_id") ?? "";
  const prefillInvoiceId = searchParams.get("invoice_id") ?? "";

  const { getNextCreditNoteNumber, createCreditNote } = useCreditNotes();
  const { contacts } = useContacts();
  const { invoices } = useInvoices();
  const { formatCurrency, baseCurrency } = useCurrency();
  const { toast } = useToast();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMode, setSubmitMode] = useState<"draft" | "issued" | null>(null);
  const [formData, setFormData] = useState({
    contact_id: prefillContactId,
    invoice_id: prefillInvoiceId,
    reason: "",
    notes: "",
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine()]);

  const customers = contacts.filter((c) => (c.type === "customer" || c.type === "both") && c.is_active);

  const customerInvoices = useMemo(() => {
    if (!formData.contact_id) return [];
    return invoices.filter(
      (inv) =>
        inv.contact_id === formData.contact_id &&
        ["sent", "partial", "overdue", "paid"].includes(inv.status),
    );
  }, [invoices, formData.contact_id]);

  const calculateLineTotal = (item: LineItem) => {
    const { line_total, tax_amount } = computeLine({
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
    });
    return { line_total, tax_amount };
  };

  /** Applies a partial line update and recomputes the line's derived money. */
  const patchLineItem = useCallback((index: number, patch: Partial<LineItem>) => {
    setLineItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], ...patch };
      const totals = calculateLineTotal(updated[index]);
      updated[index].line_total = totals.line_total;
      updated[index].tax_amount = totals.tax_amount;
      return updated;
    });
  }, []);


  const addLineItem = () => setLineItems((prev) => [...prev, emptyLine(prev.length)]);
  const removeLineItem = (index: number) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  };

  const handleInvoiceSelect = (invoiceId: string) => {
    setFormData((f) => ({ ...f, invoice_id: invoiceId }));
    const inv = invoices.find((i) => i.id === invoiceId);
    if (inv && (inv as any).items && (inv as any).items.length > 0) {
      const items: LineItem[] = (inv as any).items.map((item: any, idx: number) => ({
        product_id: item.product_id || null,
        description: item.description || "",
        quantity: item.quantity || 1,
        unit_price: item.unit_price || 0,
        tax_rate: item.tax_rate || 0,
        tax_amount: item.tax_amount || 0,
        line_total: item.line_total || 0,
        sort_order: idx,
        packaging_id: item.packaging_id ?? null,
        display_uom_id: item.display_uom_id ?? null,
        display_quantity: item.display_quantity ?? null,
        uom_snapshot: item.uom_snapshot ?? null,
      }));
      setLineItems(items);
    }
  };

  // Deep-link: pre-fill invoice after invoices load
  useEffect(() => {
    if (!prefillInvoiceId || invoices.length === 0) return;
    const inv = invoices.find((i) => i.id === prefillInvoiceId);
    if (inv) {
      setFormData((f) => ({ ...f, contact_id: inv.contact_id || f.contact_id }));
      handleInvoiceSelect(prefillInvoiceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillInvoiceId, invoices]);

  const subtotal = lineItems.reduce((sum, item) => sum + item.line_total, 0);
  const totalTax = lineItems.reduce((sum, item) => sum + item.tax_amount, 0);
  const grandTotal = subtotal + totalTax;

  const handleSubmit = async (status: "draft" | "issued") => {
    if (!formData.contact_id || !formData.reason) {
      toast({ title: "Please fill required fields", variant: "destructive" });
      return;
    }
    const validation = validateLineItems(lineItems);
    if (!validation.ok) {
      toast({ title: "Cannot create credit note", description: validation.error, variant: "destructive" });
      return;
    }

    setSubmitMode(status);
    setIsSubmitting(true);
    try {
      const cnNumber = await getNextCreditNoteNumber();
      const created = await createCreditNote(
        {
          credit_note_number: cnNumber,
          contact_id: formData.contact_id,
          invoice_id: formData.invoice_id || null,
          status,
          issue_date: new Date().toISOString().split("T")[0],
          subtotal: 0,
          tax_amount: 0,
          total: 0,
          amount_applied: 0,
          currency:
            (formData.invoice_id && customerInvoices.find((i) => i.id === formData.invoice_id)?.currency) ||
            baseCurrency,
          reason: formData.reason,
          notes: formData.notes || null,
        },
        validation.valid,
      );
      toast({
        title: status === "issued" ? "Credit note created and posted" : "Credit note saved as draft",
      });
      if (created?.id) {
        navigate(`/sales/credit-notes/${created.id}`);
      } else {
        navigate("/sales/credit-notes");
      }
    } catch (error: any) {
      toast({
        title: "Error creating credit note",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
      setSubmitMode(null);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Credit Note"
      meta="Issue a credit or refund to a customer. Save as draft or post immediately."
      cancelHref="/sales/credit-notes"
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit("issued");
      }}
      isSubmitting={isSubmitting && submitMode === "issued"}
      submitLabel="Create & Post"
      extraLeadingActions={
        <Button
          type="button"
          variant="secondary"
          onClick={() => handleSubmit("draft")}
          disabled={isSubmitting}
        >
          {isSubmitting && submitMode === "draft" ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : null}
          Save as Draft
        </Button>
      }
    >
      <div className="space-y-6 min-w-0">
        <FieldGroup label="Customer & Invoice">
          <FieldGrid columns={2}>
            <div className="space-y-2">
              <Label>Customer *</Label>
              <Select
                value={formData.contact_id}
                onValueChange={(v) => setFormData({ ...formData, contact_id: v, invoice_id: "" })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Related Invoice (optional)</Label>
              <Select
                value={formData.invoice_id}
                onValueChange={handleInvoiceSelect}
                disabled={!formData.contact_id}
              >
                <SelectTrigger>
                  <SelectValue placeholder={formData.contact_id ? "Select invoice" : "Select customer first"} />
                </SelectTrigger>
                <SelectContent>
                  {customerInvoices.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      No invoices for this customer
                    </div>
                  ) : (
                    customerInvoices.map((inv) => (
                      <SelectItem key={inv.id} value={inv.id}>
                        <div className="flex items-center gap-3 w-full">
                          <span className="font-mono text-xs font-medium">{inv.invoice_number}</span>
                          <span className="text-muted-foreground text-xs">
                            {format(new Date(inv.due_date || inv.created_at), "MMM d, yyyy")}
                          </span>
                          <span className="text-xs">Total: {formatCurrency(inv.total)}</span>
                          <span className="text-xs font-semibold text-primary">
                            {inv.status === "paid"
                              ? "Paid"
                              : `Bal: ${formatCurrency((inv.total || 0) - (inv.amount_paid || 0))}`}
                          </span>
                        </div>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </FieldGrid>
        </FieldGroup>

        <FieldGroup label="Reason">
          <div className="space-y-2">
            <Label>Reason for Credit *</Label>
            <Input
              value={formData.reason}
              onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
              placeholder="e.g., Product return, Service issue, Billing error"
            />
          </div>
        </FieldGroup>

        <FieldGroup label="Line Items">
          <EditableLineItemsGrid
            columns={PRICED_LINE_COLUMNS}
            rows={lineItems}
            addLabel="Add Item"
            onAddRow={addLineItem}
            onRemoveRow={removeLineItem}
            renderRow={(item, index, layout) => (
              <PricedLineRow
                index={index}
                item={item}
                hideProductPicker
                layout={layout}
                formatCurrency={formatCurrency}
                onPatch={patchLineItem}
                extra={
                  <OutboundLineTracking
                    productId={item.product_id ?? null}
                    quantity={item.quantity}
                    onLotChange={(allocs) =>
                      patchLineItem(index, { lot_number: lotNumberFromAllocations(allocs) } as any)
                    }
                    onSerialChange={(_ids, rows) =>
                      patchLineItem(index, { serial_number: serialNumberFromRows(rows) } as any)
                    }
                  />
                }
              />
            )}
          />

          <div className="flex justify-end pt-2">
            <div className="w-full sm:w-72 space-y-1.5 text-sm bg-muted/50 rounded-lg p-4">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal:</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax:</span>
                <span>{formatCurrency(totalTax)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-bold text-base pt-1">
                <span>Total Credit:</span>
                <span>{formatCurrency(grandTotal)}</span>
              </div>
            </div>
          </div>
        </FieldGroup>

        <FieldGroup label="Notes">
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder="Additional notes..."
            />
          </div>
        </FieldGroup>
      </div>
    </RecordFormShell>
  );
}
