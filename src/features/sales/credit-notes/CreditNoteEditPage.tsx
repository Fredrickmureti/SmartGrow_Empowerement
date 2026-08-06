// @ts-nocheck
/**
 * CreditNoteEditPage — `/sales/credit-notes/:id/edit`.
 *
 * Phase-3 route replacement for the retired `EditCreditNoteDialog`.
 * Only draft credit notes can be edited.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useContacts } from "@/hooks/useContacts";
import { useInvoices } from "@/hooks/useInvoices";
import { useCreditNotes, CreditNoteItem } from "@/hooks/useCreditNotes";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { computeLine } from "@/lib/invoiceLineMath";
import { validateLineItems } from "@/lib/validation/lineItems";
import { normalizeError } from "@/services/resilience";

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
import { Loader2 } from "lucide-react";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { OutboundLineTracking } from "@/components/inventory/OutboundLineTracking";
import {
  lotNumberFromAllocations,
  serialNumberFromRows,
} from "@/components/inventory/outboundLineTrackingUtils";

type LineItem = Omit<CreditNoteItem, "id" | "credit_note_id"> & { id?: string };

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

export default function CreditNoteEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { refreshCreditNotes } = useCreditNotes();
  const { contacts } = useContacts();
  const { invoices } = useInvoices();
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();

  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [creditNote, setCreditNote] = useState<any>(null);
  const [formData, setFormData] = useState({
    contact_id: "",
    invoice_id: "",
    reason: "",
    notes: "",
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  const customers = contacts.filter((c) => (c.type === "customer" || c.type === "both") && c.is_active);

  const customerInvoices = useMemo(() => {
    if (!formData.contact_id) return [];
    return invoices.filter(
      (inv) =>
        inv.contact_id === formData.contact_id &&
        ["sent", "partial", "overdue", "paid"].includes(inv.status),
    );
  }, [invoices, formData.contact_id]);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setIsLoading(true);
      try {
        const { data: cn, error: cnErr } = await supabase
          .from("credit_notes")
          .select("*")
          .eq("id", id)
          .single();
        if (cnErr) throw cnErr;
        if (cn.status !== "draft") {
          toast({
            title: "Cannot edit",
            description: `Only draft credit notes can be edited. This credit note is "${cn.status}".`,
            variant: "destructive",
          });
          navigate(`/sales/credit-notes/${id}`);
          return;
        }
        setCreditNote(cn);
        setFormData({
          contact_id: cn.contact_id || "",
          invoice_id: cn.invoice_id || "",
          reason: cn.reason || "",
          notes: cn.notes || "",
        });

        const { data: items, error: itemsErr } = await supabase
          .from("credit_note_items")
          .select("*")
          .eq("credit_note_id", id)
          .order("sort_order");
        if (itemsErr) throw itemsErr;

        setLineItems(
          items && items.length > 0
            ? items.map((item: any) => ({
                id: item.id,
                product_id: item.product_id,
                description: item.description,
                quantity: item.quantity,
                unit_price: item.unit_price,
                tax_rate: item.tax_rate || 0,
                tax_amount: item.tax_amount || 0,
                line_total: item.line_total,
                sort_order: item.sort_order || 0,
              }))
            : [emptyLine()],
        );
      } catch (error: any) {
        toast({
          title: "Error loading credit note",
          description: normalizeError(error).message,
          variant: "destructive",
        });
        navigate("/sales/credit-notes");
      } finally {
        setIsLoading(false);
      }
    })();
  }, [id, navigate, toast]);

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

  const subtotal = lineItems.reduce((sum, item) => sum + item.line_total, 0);
  const totalTax = lineItems.reduce((sum, item) => sum + item.tax_amount, 0);
  const grandTotal = subtotal + totalTax;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!creditNote) return;

    if (!formData.contact_id || !formData.reason) {
      toast({ title: "Please fill required fields", variant: "destructive" });
      return;
    }
    const validation = validateLineItems(lineItems);
    if (!validation.ok) {
      toast({ title: "Cannot save credit note", description: validation.error, variant: "destructive" });
      return;
    }
    const validItems = validation.valid;

    setIsSubmitting(true);
    try {
      const sub = validItems.reduce((s, i) => s + i.quantity * i.unit_price, 0);
      const tax = validItems.reduce((s, i) => s + i.tax_amount, 0);
      const total = sub + tax;

      const { error: cnErr } = await supabase
        .from("credit_notes")
        .update({
          contact_id: formData.contact_id || null,
          invoice_id: formData.invoice_id || null,
          reason: formData.reason,
          notes: formData.notes || null,
          subtotal: sub,
          tax_amount: tax,
          total,
        })
        .eq("id", creditNote.id);
      if (cnErr) throw cnErr;

      await supabase.from("credit_note_items").delete().eq("credit_note_id", creditNote.id);
      const newItems = validItems.map((item, index) => ({
        credit_note_id: creditNote.id,
        product_id: item.product_id || null,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        tax_amount: item.tax_amount,
        line_total: item.line_total,
        sort_order: index,
      }));
      const { error: insertErr } = await supabase.from("credit_note_items").insert(newItems);
      if (insertErr) throw insertErr;

      toast({ title: "Credit note updated" });
      await refreshCreditNotes();
      navigate(`/sales/credit-notes/${creditNote.id}`);
    } catch (error: any) {
      toast({
        title: "Error updating credit note",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Credit Note"
      recordRef={creditNote?.credit_note_number}
      meta="Only draft credit notes can be edited."
      cancelHref={`/sales/credit-notes/${creditNote?.id}`}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Save changes"
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
                onValueChange={(v) => setFormData({ ...formData, invoice_id: v })}
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
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-xs font-medium">{inv.invoice_number}</span>
                          <span className="text-xs">{formatCurrency(inv.total)}</span>
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
