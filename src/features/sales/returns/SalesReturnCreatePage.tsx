/**
 * SalesReturnCreatePage — `/sales/returns/new`.
 *
 * Phase-3 route replacement for the retired `CreateSalesReturnDialog`.
 * Hosts the same form body on top of `RecordFormShell`.
 *
 * Deep-link params:
 *   ?contact_id=<uuid>   pre-fill customer
 *   ?invoice_id=<uuid>   pre-fill the original invoice (auto-loads items)
 */
import { useState, useMemo, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useSalesReturns } from "@/hooks/useSalesReturns";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
import { useInvoices } from "@/hooks/useInvoices";
import { useCurrency } from "@/hooks/useCurrency";
import { OutboundLineTracking } from "@/components/inventory/OutboundLineTracking";
import {
  lotNumberFromAllocations,
  serialNumberFromRows,
} from "@/components/inventory/outboundLineTrackingUtils";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { SalesReturnLineRow, RETURN_LINE_COLUMNS } from "@/components/documents/lines/SalesReturnLineRow";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { DocumentLineScanner } from "@/components/documents/lines/DocumentLineScanner";
import {
  usePricedLineScan,
  scanUnitPrice,
  scanTaxRate,
} from "@/features/sales/scan-session/useDocumentLineScan";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Plus, Trash2, FileText, Info, PackageCheck } from "lucide-react";
import { toast } from "sonner";
import { validateLineItems } from "@/lib/validation/lineItems";
import { format } from "date-fns";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";

const formSchema = z.object({
  contact_id: z.string().min(1, "Customer is required"),
  invoice_id: z.string().optional(),
  return_date: z.string(),
  reason: z.string().min(1, "Reason is required"),
  notes: z.string().optional(),
});

interface LineItem {
  product_id: string | null;
  invoice_item_id: string | null;
  description: string;
  quantity: number;
  max_quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number;
  condition: string;
  return_reason: string;
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
  // Phase A.4 — picker output persisted to sales_return_items.
  lot_number?: string | null;
  serial_number?: string | null;
  /**
   * Phase 8 — tax basis provenance. For an invoice-sourced line the tax the
   * original invoice line charged is the only lawful basis; the figures below
   * are a *preview* of what `create_sales_return_atomic` will resolve
   * server-side via `resolve_sales_return_line_tax`. The server never trusts
   * the tax we send.
   */
  invoiced_quantity?: number | null;
  source_tax_amount?: number | null;
  source_discount_percent?: number | null;
}

const emptyLine = (): LineItem => ({
  product_id: null,
  invoice_item_id: null,
  description: "",
  quantity: 1,
  max_quantity: 999,
  unit_price: 0,
  tax_rate: 0,
  tax_amount: 0,
  condition: "good",
  return_reason: "",
});

/** Pro-rates the original invoice line's tax onto the returned quantity. */
const previewLineTax = (line: LineItem): number => {
  if (line.invoice_item_id && line.invoiced_quantity) {
    const proportion = Math.abs(line.quantity) / Math.abs(line.invoiced_quantity);
    return (line.source_tax_amount ?? 0) * proportion;
  }
  return line.quantity * line.unit_price * ((line.tax_rate || 0) / 100);
};


export default function SalesReturnCreatePage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Handheld list pages deep-link here with `openScanSession` so the
  // camera sheet opens immediately (see ScanToDocumentButton).
  const openScanSessionOnMount =
    ((location.state as { openScanSession?: boolean } | null)?.openScanSession) === true;
  const [searchParams] = useSearchParams();
  const prefillContactId = searchParams.get("contact_id") ?? undefined;
  const prefillInvoiceId = searchParams.get("invoice_id") ?? undefined;

  const { createSalesReturn } = useSalesReturns();
  const { contacts } = useContacts();
  const { products, branchScopeLabel } = useBranchScopedProducts();
  const { invoices } = useInvoices();
  const { formatCurrency } = useCurrency();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine()]);

  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both");

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      contact_id: prefillContactId || "",
      invoice_id: prefillInvoiceId || "",
      return_date: new Date().toISOString().split("T")[0],
      reason: "",
      notes: "",
    },
  });

  const selectedContactId = form.watch("contact_id");
  const selectedInvoiceId = form.watch("invoice_id");

  // Reference-document lines for the selected invoice, with the remaining
  // returnable quantity per line (v_sales_returnable_qty).
  const {
    lines: returnableLines,
    isLoading: linesLoading,
    error: linesError,
  } = useInvoiceReturnableLines(selectedInvoiceId || null);
  const [pickerOpen, setPickerOpen] = useState(false);

  /** Builds a locked, invoice-sourced return line. */
  const lineFromInvoiceLine = (
    src: ReturnableInvoiceLine,
    quantity: number,
  ): LineItem => ({
    product_id: src.product_id,
    invoice_item_id: src.invoice_item_id,
    description: src.description,
    quantity,
    max_quantity: src.returnable_qty,
    unit_price: src.net_unit_price,
    tax_rate: src.tax_rate,
    tax_amount: src.source_tax_amount * (src.invoiced_qty ? quantity / src.invoiced_qty : 0),
    condition: "good",
    return_reason: "",
    packaging_id: src.packaging_id,
    display_uom_id: src.display_uom_id,
    display_quantity: src.display_quantity,
    invoiced_quantity: src.invoiced_qty,
    source_tax_amount: src.source_tax_amount,
    source_discount_percent: src.discount_percent,
  });

  /** Replaces the invoice-sourced lines with the picker's selection. */
  const applyPickedLines = (
    picked: { line: ReturnableInvoiceLine; quantity: number }[],
  ) => {
    setLineItems((prev) => {
      const offInvoice = prev.filter(
        (l) => !l.invoice_item_id && (l.product_id || l.description.trim()),
      );
      return [...picked.map((p) => lineFromInvoiceLine(p.line, p.quantity)), ...offInvoice];
    });
  };

  const handleInvoiceSelect = (invoiceId: string) => {
    form.setValue("invoice_id", invoiceId);
    // Drop stale invoice-sourced lines; the picker seeds the new ones.
    setLineItems((prev) => {
      const kept = prev.filter(
        (l) => !l.invoice_item_id && (l.product_id || l.description.trim()),
      );
      return kept.length > 0 ? kept : [];
    });
    setPickerOpen(true);
  };

  // Deep-link: pre-fill invoice once invoices load
  useEffect(() => {
    if (!prefillInvoiceId || invoices.length === 0) return;
    const inv = invoices.find((i) => i.id === prefillInvoiceId);
    if (inv) {
      form.setValue("contact_id", inv.contact_id || "");
      form.setValue("invoice_id", prefillInvoiceId);
      setPickerOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillInvoiceId, invoices]);


  const customerInvoices = useMemo(() => {
    if (!selectedContactId) return [];
    return invoices.filter(
      (inv) =>
        inv.contact_id === selectedContactId &&
        ["confirmed", "sent", "partial", "paid", "overdue"].includes(inv.status)
    );
  }, [invoices, selectedContactId]);

  const selectedInvoice = useMemo(() => {
    if (!selectedInvoiceId) return null;
    return invoices.find((i) => i.id === selectedInvoiceId) || null;
  }, [invoices, selectedInvoiceId]);

  // Scan-to-line parity — the Sales workspace scan transport is live on every
  // page (SalesLayout mounts SalesScanProvider); this form is a consumer of it.
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const { handleScanResolved, handleScanSessionCommit, flashIndex } = usePricedLineScan(
    setLineItems,
    (resolved, quantity) => ({
      ...emptyLine(),
      product_id: resolved.productId,
      description: resolved.name,
      quantity,
      unit_price: scanUnitPrice(resolved),
      tax_rate: scanTaxRate(resolved),
    }),
  );

  const addLineItem = () => setLineItems([...lineItems, emptyLine()]);

  const removeLineItem = (index: number) => {
    setLineItems((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [emptyLine()];
    });
  };

  /**
   * Applies a partial line update: derives product defaults, clamps the
   * returned quantity to the invoiced ceiling, and re-previews line tax.
   * Invoice-sourced lines keep the original line's price and tax basis —
   * the current product price/tax setting must not leak into a return.
   */
  const patchLineItem = useCallback(
    (index: number, patch: Partial<LineItem>) => {
      setLineItems((prev) =>
        prev.map((it, i) => {
          if (i !== index) return it;
          const next: LineItem = { ...it, ...patch };
          if (patch.product_id && !next.invoice_item_id) {
            const product = products.find((p) => p.id === patch.product_id);
            if (product) {
              next.description = product.name;
              next.unit_price = product.unit_price;
            }
          }
          if (typeof next.quantity === "number") {
            next.quantity = Math.min(next.quantity, next.max_quantity);
          }
          next.tax_amount = previewLineTax(next);
          return next;
        }),
      );
    },
    [products],
  );


  const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const totalTax = lineItems.reduce((sum, item) => sum + item.tax_amount, 0);
  const grandTotal = subtotal + totalTax;
  const hasInventoryItems = lineItems.some((item) => item.product_id);

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    const validation = validateLineItems(lineItems, { enforceMaxQuantity: true });
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }
    const validatedLines = validation.valid;

    setIsSubmitting(true);
    try {
      const items = validatedLines.map((item) => ({
        product_id: item.product_id,
        invoice_item_id: item.invoice_item_id,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        tax_amount: item.tax_amount,
        line_total: item.quantity * item.unit_price,
        condition: item.condition,
        return_reason: item.return_reason || null,
        packaging_id: item.packaging_id ?? null,
        display_uom_id: item.display_uom_id ?? null,
        display_quantity: item.display_quantity ?? null,
      }));

      const created = await createSalesReturn(
        {
          contact_id: values.contact_id,
          invoice_id: values.invoice_id || null,
          return_date: values.return_date,
          reason: values.reason,
          notes: values.notes,
          subtotal,
          tax_amount: totalTax,
          total: grandTotal,
          status: "pending",
        },
        items,
      );

      if (created?.id) {
        navigate(`/sales/returns/${created.id}`);
      } else {
        navigate("/sales/returns");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "paid": return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400";
      case "partial": return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400";
      case "overdue": return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
      default: return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400";
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Sales Return"
      meta={
        <>
          Record items returned by a customer. Select the original invoice to auto-populate items · Stock shown for:{" "}
          <span className="font-medium text-foreground">{branchScopeLabel}</span>
        </>
      }
      cancelHref="/sales/returns"
      onSubmit={form.handleSubmit(onSubmit)}
      isSubmitting={isSubmitting}
      submitDisabled={grandTotal <= 0}
      submitLabel="Create Sales Return"
    >
      <Form {...form}>
        <div className="space-y-6 min-w-0">
          <FieldGroup label="Customer & Invoice">
            <FieldGrid columns={2}>
              <FormField
                control={form.control}
                name="contact_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Customer *</FormLabel>
                    <Select
                      onValueChange={(v) => {
                        field.onChange(v);
                        form.setValue("invoice_id", "");
                        setLineItems([emptyLine()]);
                      }}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select customer" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {customers.map((contact) => (
                          <SelectItem key={contact.id} value={contact.id}>
                            {contact.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormItem>
                <FormLabel>Original Invoice</FormLabel>
                <Select
                  value={selectedInvoiceId || ""}
                  onValueChange={handleInvoiceSelect}
                  disabled={!selectedContactId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={selectedContactId ? "Select invoice (optional)" : "Select customer first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {customerInvoices.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">No invoices for this customer</div>
                    ) : (
                      customerInvoices.map((inv) => (
                        <SelectItem key={inv.id} value={inv.id}>
                          <div className="flex items-center gap-2">
                            <FileText className="h-3 w-3 text-muted-foreground" />
                            <span className="font-mono text-xs">{inv.invoice_number}</span>
                            <span className="text-xs text-muted-foreground">{format(new Date(inv.issue_date), "MMM d, yyyy")}</span>
                            <span className="text-xs font-medium">{formatCurrency(inv.total)}</span>
                            <Badge variant="outline" className="text-[10px] px-1">{inv.status}</Badge>
                          </div>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </FormItem>

              <FormField
                control={form.control}
                name="return_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Return Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select reason" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="defective">Defective Product</SelectItem>
                        <SelectItem value="wrong_item">Wrong Item Delivered</SelectItem>
                        <SelectItem value="damaged">Damaged in Transit</SelectItem>
                        <SelectItem value="not_needed">No Longer Needed</SelectItem>
                        <SelectItem value="quality">Quality Issue</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGrid>
          </FieldGroup>

          {selectedInvoice && (
            <Card className="border-primary/20 bg-primary/5">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <FileText className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Invoice Details</span>
                  <Badge className={`text-[10px] px-1.5 ${getStatusColor(selectedInvoice.status)}`}>
                    {selectedInvoice.status}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground text-xs block">Invoice #</span>
                    <span className="font-mono font-medium">{selectedInvoice.invoice_number}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs block">Invoice Date</span>
                    <span>{format(new Date(selectedInvoice.issue_date), "MMM d, yyyy")}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs block">Invoice Total</span>
                    <span className="font-semibold">{formatCurrency(selectedInvoice.total)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs block">Outstanding</span>
                    <span className="font-semibold text-destructive">
                      {formatCurrency((selectedInvoice.total || 0) - (selectedInvoice.amount_paid || 0))}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <FieldGroup label="Returned Items">
            <EditableLineItemsGrid
              columns={RETURN_LINE_COLUMNS}
              rows={lineItems}
              toolbar={
                <DocumentLineScanner
                  documentLabel="Sales return"
                  businessId={currentBusiness?.id}
                  branchId={currentBranch?.id ?? null}
                  onResolved={handleScanResolved}
                  onSessionCommit={handleScanSessionCommit}
                  openSessionOnMount={openScanSessionOnMount}
                />
              }
              addLabel="Add Item"
              onAddRow={addLineItem}
              onRemoveRow={removeLineItem}
              renderRow={(item, index, layout) => (
                <SalesReturnLineRow
                  index={index}
                  item={item}
                  flashed={flashIndex === index}
                  products={products}
                  layout={layout}
                  fromInvoice={!!selectedInvoiceId}
                  formatCurrency={formatCurrency}
                  onPatch={patchLineItem}
                  extra={
                    <OutboundLineTracking
                      productId={item.product_id ?? null}
                      quantity={item.quantity}
                      onLotChange={(allocs) =>
                        patchLineItem(index, {
                          lot_number: lotNumberFromAllocations(allocs),
                        } as any)
                      }
                      onSerialChange={(_ids, rows) =>
                        patchLineItem(index, {
                          serial_number: serialNumberFromRows(rows),
                        } as any)
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
                  <span>Return Total:</span>
                  <span className="text-destructive">-{formatCurrency(grandTotal)}</span>
                </div>
                <p className="pt-1 text-[11px] leading-snug text-muted-foreground">
                  {lineItems.some((l) => l.invoice_item_id)
                    ? "Tax is taken from the original invoice lines and confirmed by the server on save."
                    : "Tax is confirmed by the server on save."}
                </p>

              </div>
            </div>
          </FieldGroup>

          {grandTotal > 0 && (
            <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20">
              <CardContent className="p-4">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="space-y-1.5 text-sm">
                    <p className="font-medium text-amber-800 dark:text-amber-400">Expected Financial Effect</p>
                    <ul className="space-y-1 text-muted-foreground text-xs">
                      <li>• A <strong>Sales Return</strong> for <strong>{formatCurrency(grandTotal)}</strong> will be created in <strong>Pending</strong> status.</li>
                      <li>• Upon <strong>approval</strong>, a draft <strong>Credit Note</strong> will be auto-generated.</li>
                      {hasInventoryItems && (
                        <li className="flex items-center gap-1">
                          <PackageCheck className="h-3 w-3 inline" />
                          Inventory will be <strong>restocked</strong> for returned products.
                        </li>
                      )}
                      <li>• When the Credit Note is <strong>issued</strong>, a journal entry will reverse the revenue and reduce Accounts Receivable.</li>
                      <li>• The credit can then be <strong>applied to future invoices</strong> or <strong>refunded</strong>.</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <FieldGroup label="Notes">
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea {...field} placeholder="Additional notes about the return..." rows={2} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </FieldGroup>
        </div>
      </Form>
    </RecordFormShell>
  );
}
