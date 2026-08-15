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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
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
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { DocumentLineScanner } from "@/components/documents/lines/DocumentLineScanner";
import {
  usePricedLineScan,
  scanUnitPrice,
  scanTaxRate,
} from "@/features/sales/scan-session/useDocumentLineScan";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { Badge } from "@/components/ui/badge";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
import { useInvoiceCreditableLines } from "./useInvoiceCreditableLines";
import { InvoiceLineCreditPicker, type PickedCreditLine } from "./InvoiceLineCreditPicker";
import { CreditReasonField } from "./CreditReasonField";
import { useUnitsForProducts } from "@/hooks/useSellableUnits";
import { useLinePriceResolver, useServerPriceApplier } from "@/hooks/useLinePriceResolver";

/**
 * `source_invoice_item_id` is durable provenance: it marks a line as picked
 * off the source invoice, is submitted as `invoice_item_id`, and is stored on
 * `credit_note_items`. The server then resolves the description, price,
 * discount and tax from the invoice line itself and enforces the remaining
 * creditable quantity — the money shown here is a preview, not the record.
 */
type LineItem = Omit<CreditNoteItem, "id" | "credit_note_id"> & {
  source_invoice_item_id?: string | null;
};

const emptyLine = (sort_order = 0): LineItem => ({
  product_id: null,
  description: "",
  quantity: 1,
  unit_price: 0,
  tax_rate: 0,
  tax_amount: 0,
  line_total: 0,
  sort_order,
  source_invoice_item_id: null,
});

/** Client intent → server payload. Invoice-referenced lines carry the link. */
const toWireLines = (items: LineItem[]) =>
  items.map(({ source_invoice_item_id, ...rest }, index) => ({
    ...rest,
    sort_order: rest.sort_order ?? index,
    invoice_item_id: source_invoice_item_id ?? null,
  }));

export default function CreditNoteCreatePage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Handheld list pages deep-link here with `openScanSession` so the
  // camera sheet opens immediately (see ScanToDocumentButton).
  const openScanSessionOnMount =
    ((location.state as { openScanSession?: boolean } | null)?.openScanSession) === true;
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
  const [reasonChoice, setReasonChoice] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * Idempotency key for this form instance. A double click, a retry after a
   * network wobble, or a resubmitted request all carry the same key, so the
   * server returns the credit note it already created instead of creating a
   * second economic document.
   */
  const requestIdRef = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `cn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const customers = contacts.filter((c) => (c.type === "customer" || c.type === "both") && c.is_active);

  const customerInvoices = useMemo(() => {
    if (!formData.contact_id) return [];
    return invoices.filter(
      (inv) =>
        inv.contact_id === formData.contact_id &&
        ["sent", "partial", "overdue", "paid"].includes(inv.status),
    );
  }, [invoices, formData.contact_id]);

  const selectedInvoice = useMemo(
    () => invoices.find((i) => i.id === formData.invoice_id) ?? null,
    [invoices, formData.invoice_id],
  );

  const {
    lines: invoiceLines,
    isLoading: invoiceLinesLoading,
    error: invoiceLinesError,
  } = useInvoiceCreditableLines(formData.invoice_id || null);

  const { products } = useBranchScopedProducts();

  /** Sell units per product; the server re-derives the base quantity. */

  const unitsFor = useUnitsForProducts(products);

  // Scan-to-line parity — the Sales workspace scan transport is live on every
  // page (SalesLayout mounts SalesScanProvider); this form is a consumer of it.
  const { currentBusiness } = useBusinesses();

  /** Server-authoritative price for a line, previewed in the editor. */
  const resolvePrice = useLinePriceResolver(currentBusiness?.id, formData.contact_id || null);
  const applyServerPrice = useServerPriceApplier(lineItems, setLineItems, resolvePrice);

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
    // Re-price whenever what the customer buys changes (unit or pack).
    if ((patch as Record<string, unknown>).packaging_id !== undefined || (patch as Record<string, unknown>).display_uom_id !== undefined) {
      void applyServerPrice(index, patch as never);
    }
    setLineItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], ...patch };
      const totals = calculateLineTotal(updated[index]);
      updated[index].line_total = totals.line_total;
      updated[index].tax_amount = totals.tax_amount;
      return updated;
    });
  }, [applyServerPrice]);

  const { currentBranch } = useBranches();

  const { handleScanResolved, handleScanSessionCommit, flashIndex } = usePricedLineScan(
    setLineItems,
    (resolved, quantity, lines) => {
      const seed = {
        ...emptyLine(lines.length),
        product_id: resolved.productId,
        description: resolved.name,
        quantity,
        unit_price: scanUnitPrice(resolved),
        tax_rate: scanTaxRate(resolved),
      };
      const { line_total, tax_amount } = computeLine(seed);
      return { ...seed, line_total, tax_amount };
    },
  );

  const addLineItem = () => setLineItems((prev) => [...prev, emptyLine(prev.length)]);
  const removeLineItem = (index: number) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  };

  /** Off-invoice lines only — an invoice-sourced line keeps the invoiced price. */
  const handleProductSelect = (index: number, productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    patchLineItem(index, {
      product_id: productId,
      description: product.name,
      unit_price: product.unit_price,
    });
    // Product scalar is an optimistic placeholder; the server resolver
    // (price list > price book > product) is the authority and is what the
    // database stamps on insert.
    void applyServerPrice(index, { product_id: productId });
  };

  const handleInvoiceSelect = (invoiceId: string) => {
    setFormData((f) => ({ ...f, invoice_id: invoiceId }));
    // Lines are authored by picking off the invoice, never by retyping.
    setLineItems([emptyLine()]);
    if (invoiceId) setPickerOpen(true);
  };

  /**
   * Picked invoice lines replace the invoice-sourced part of the document and
   * keep whatever off-invoice lines the operator added by hand.
   */
  const applyPickedLines = (picked: PickedCreditLine[]) => {
    setLineItems((prev) => {
      const manual = prev.filter(
        (l) => !l.source_invoice_item_id && (l.description.trim() || l.product_id),
      );
      const fromInvoice: LineItem[] = picked.map(({ line, quantity }, idx) => {
        const seed: LineItem = {
          ...emptyLine(idx),
          product_id: line.product_id,
          description: line.description,
          quantity,
          unit_price: line.net_unit_price,
          tax_rate: line.tax_rate,
          source_invoice_item_id: line.invoice_item_id,
        } as LineItem;
        const { line_total, tax_amount } = computeLine(seed);
        return { ...seed, line_total, tax_amount };
      });
      const merged = [...fromInvoice, ...manual].map((l, i) => ({ ...l, sort_order: i }));
      return merged.length > 0 ? merged : [emptyLine()];
    });
  };

  const pickedQuantities = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of lineItems) {
      if (l.source_invoice_item_id) map[l.source_invoice_item_id] = l.quantity;
    }
    return map;
  }, [lineItems]);

  // Deep-link: pre-fill invoice after invoices load
  useEffect(() => {
    if (!prefillInvoiceId || invoices.length === 0) return;
    const inv = invoices.find((i) => i.id === prefillInvoiceId);
    if (inv) {
      setFormData((f) => ({
        ...f,
        contact_id: inv.contact_id || f.contact_id,
        invoice_id: prefillInvoiceId,
      }));
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
        toWireLines(validation.valid as LineItem[]),
        requestIdRef.current,
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
          <FieldGrid columns={2}>
            <CreditReasonField
              choice={reasonChoice}
              onChoiceChange={setReasonChoice}
              reason={formData.reason}
              onReasonChange={(reason) => setFormData((f) => ({ ...f, reason }))}
              notes={formData.notes}
              onNotesChange={(notes) => setFormData((f) => ({ ...f, notes }))}
            />
          </FieldGrid>
        </FieldGroup>

        <FieldGroup label="Line Items">
          <EditableLineItemsGrid
            columns={PRICED_LINE_COLUMNS}
            rows={lineItems}
            toolbar={
              <div className="flex flex-wrap items-center gap-2">
                {formData.invoice_id && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPickerOpen(true)}
                  >
                    {lineItems.some((l) => l.source_invoice_item_id)
                      ? "Edit invoice lines"
                      : "Select invoice lines"}
                  </Button>
                )}
                <DocumentLineScanner
                  documentLabel="Credit note"
                  businessId={currentBusiness?.id}
                  branchId={currentBranch?.id ?? null}
                  onResolved={handleScanResolved}
                  onSessionCommit={handleScanSessionCommit}
                  openSessionOnMount={openScanSessionOnMount}
                />
              </div>
            }
            addLabel={formData.invoice_id ? "Add off-invoice line" : "Add Item"}
            onAddRow={addLineItem}
            onRemoveRow={removeLineItem}
            renderRow={(item, index, layout) => {
              const fromInvoice = Boolean(item.source_invoice_item_id);
              return (
                <PricedLineRow
                  unitsFor={unitsFor}
                  index={index}
                  item={item}
                  products={fromInvoice ? undefined : products}
                  hideProductPicker={fromInvoice}
                  lockedCells={fromInvoice ? ["item", "unit_price", "tax_rate"] : undefined}
                  flashed={flashIndex === index}
                  layout={layout}
                  formatCurrency={formatCurrency}
                  onPatch={patchLineItem}
                  onProductSelect={fromInvoice ? undefined : handleProductSelect}
                  extra={
                    <div className="space-y-1">
                      <Badge variant={fromInvoice ? "secondary" : "outline"} className="text-[10px]">
                        {fromInvoice
                          ? `From ${selectedInvoice?.invoice_number ?? "invoice"}`
                          : "Off-invoice line"}
                      </Badge>
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
                    </div>
                  }
                />
              );
            }}
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


        <InvoiceLineCreditPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          invoiceNumber={selectedInvoice?.invoice_number}
          lines={invoiceLines}
          isLoading={invoiceLinesLoading}
          error={invoiceLinesError}
          existing={pickedQuantities}
          formatCurrency={formatCurrency}
          onConfirm={applyPickedLines}
        />
      </div>
    </RecordFormShell>
  );
}
