/**
 * InvoiceEditPage — `/sales/invoices/:id/edit`.
 *
 * Phase-3 route replacement for the retired `EditInvoiceDialog`. Loads
 * the draft invoice from the URL param, hosts the form body on top of
 * `RecordFormShell`, and lands the user back on the invoice's object
 * page on save. Only draft invoices are editable (server contract);
 * a non-draft :id redirects to the object page with a toast.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { InvoiceLineRow, INVOICE_LINE_COLUMNS } from "@/components/invoices/InvoiceLineRow";
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { Invoice, InvoiceItem } from "@/hooks/useInvoices";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts as useProducts } from "@/hooks/useBranchScopedProducts";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useOrganization } from "@/hooks/useOrganization";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { computeLine, computeTotals } from "@/lib/invoiceLineMath";
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
import { Loader2, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import {
  evaluateStock,
} from "@/components/inventory/StockAvailabilityIndicator";
import { validateLineItems } from "@/lib/validation/lineItems";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { AITextAssist } from "@/components/shared/AITextAssist";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { CapabilityGate } from "@/components/apps/CapabilityGate";
import { DocumentLineScanner } from "@/components/documents/lines/DocumentLineScanner";
import {
  usePricedLineScan,
  scanUnitPrice,
  scanTaxRate,
} from "@/features/sales/scan-session/useDocumentLineScan";
import { cn } from "@/lib/utils";
import { normalizeError } from "@/services/resilience";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { useUnitsForProducts } from "@/hooks/useSellableUnits";
import { useLinePriceResolver, useServerPriceApplier } from "@/hooks/useLinePriceResolver";

type LineItem = Omit<InvoiceItem, "id" | "invoice_id"> & { id?: string };

export default function InvoiceEditPage() {
  const navigate = useNavigate();
  const { id: invoiceId } = useParams<{ id: string }>();
  const { currentOrg } = useOrganization();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const onOpenChange = (_next: boolean) => {
    // Route pages replace open/close with navigation.
  };
  const onSuccess = () => {
    if (invoice?.id) navigate(`/sales/invoices/${invoice.id}`);
    else navigate("/sales/invoices");
  };
  const open = true;

  const { contacts } = useContacts();
  const { products } = useProducts();
  /** Sell units per product; the server re-derives the base quantity. */
  const unitsFor = useUnitsForProducts(products);
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmOversell, setConfirmOversell] = useState(false);

  const [formData, setFormData] = useState({
    contact_id: "",
    due_date: "",
    notes: "",
    terms: "",
    discount_amount: 0,
    project_id: null,
  });

  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  /** Server-authoritative price for a line, previewed in the editor. */
  const resolvePrice = useLinePriceResolver(currentBusiness?.id, formData.contact_id || null);
  const applyServerPrice = useServerPriceApplier(lineItems, setLineItems, resolvePrice);
  const linesTableRef = useRef<HTMLDivElement | null>(null);

  // Fetch the invoice by :id from the URL. Only drafts are editable —
  // otherwise redirect to the object page with a message.
  useEffect(() => {
    if (!invoiceId || !currentBusiness?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("*, contact:contacts(name, email, phone)")
        .eq("id", invoiceId)
        .eq("organization_id", currentOrg?.id || "")
        .eq("business_id", currentBusiness.id)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        toast({
          title: "Invoice not found",
          description: error?.message,
          variant: "destructive",
        });
        navigate("/sales/invoices");
        return;
      }
      if (data.status !== "draft") {
        toast({
          title: "Cannot edit",
          description: "Only draft invoices can be edited.",
          variant: "destructive",
        });
        navigate(`/sales/invoices/${data.id}`);
        return;
      }
      setInvoice(data as unknown as Invoice);
    })();
    return () => {
      cancelled = true;
    };
  }, [invoiceId, currentBusiness?.id, currentOrg?.id]);

  useEffect(() => {
    if (open && invoice) {
      loadInvoiceData();
    }
  }, [open, invoice?.id]);


  const loadInvoiceData = async () => {
    if (!invoice) return;
    setIsLoading(true);

    try {
      const { data: items, error } = await supabase
        .from("invoice_items")
        .select("*")
        .eq("invoice_id", invoice.id)
        .order("sort_order");

      if (error) throw error;

      setFormData({
        contact_id: invoice.contact_id || "",
        due_date: invoice.due_date,
        notes: invoice.notes || "",
        terms: invoice.terms || "",
        discount_amount: invoice.discount_amount || 0,
        project_id: (invoice as any).project_id ?? null,
      });

      setLineItems(
        items.map((item) => ({
          id: item.id,
          product_id: item.product_id,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate || 0,
          tax_amount: item.tax_amount || 0,
          discount_percent: item.discount_percent || 0,
          line_total: item.line_total,
          sort_order: item.sort_order || 0,
          project_id: (item as { project_id?: string | null }).project_id ?? null,
          task_id: (item as { task_id?: string | null }).task_id ?? null,
        }))
      );
    } catch (error) {
      console.error("Error loading invoice:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const calculateLineTotal = (item: LineItem) => {
    const { line_total, tax_amount } = computeLine({
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_percent: item.discount_percent,
      tax_rate: item.tax_rate,
    });
    return { line_total, tax_amount };
  };

  const updateLineItem = useCallback((index: number, updates: Partial<LineItem>) => {
    // Re-price whenever what the customer buys changes (unit or pack).
    if ((updates as Record<string, unknown>).packaging_id !== undefined || (updates as Record<string, unknown>).display_uom_id !== undefined) {
      void applyServerPrice(index, updates as never);
    }
    setLineItems((prev) => {
      const newItems = [...prev];
      const updatedItem = { ...newItems[index], ...updates };
      const { line_total, tax_amount } = computeLine({
        quantity: updatedItem.quantity,
        unit_price: updatedItem.unit_price,
        discount_percent: updatedItem.discount_percent,
        tax_rate: updatedItem.tax_rate,
      });
      newItems[index] = { ...updatedItem, line_total, tax_amount };
      return newItems;
    });
  }, []);

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [
      ...prev,
      {
        description: "",
        quantity: 1,
        unit_price: 0,
        tax_rate: 0,
        tax_amount: 0,
        discount_percent: 0,
        line_total: 0,
        sort_order: prev.length,
      },
    ]);
  }, []);

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }, []);

  const handleProductSelect = useCallback((index: number, productId: string) => {
    // Product scalar is an optimistic placeholder; the server resolver
    // (price list > price book > product) is the authority and is what the
    // database stamps on insert.
    void applyServerPrice(index, { product_id: productId });
    const product = products.find((p) => p.id === productId);
    if (product) {
      updateLineItem(index, {
        product_id: productId,
        description: product.name,
        unit_price: product.unit_price,
        tax_rate: product.tax_rate || 0,
      });
    }
  }, [products, updateLineItem]);

  /**
   * Scan-first line entry — shared with every other Sales document via
   * `usePricedLineScan` (doc_author: a repeat scan flashes the line rather
   * than silently bumping its quantity).
   */
  const { handleScanResolved, handleScanSessionCommit, flashIndex } = usePricedLineScan<LineItem>(
    setLineItems,
    (resolved, quantity, lines) => {
      const seed: LineItem = {
        product_id: resolved.productId,
        description: resolved.name,
        quantity,
        unit_price: scanUnitPrice(resolved),
        tax_rate: scanTaxRate(resolved),
        tax_amount: 0,
        discount_percent: 0,
        line_total: 0,
        sort_order: lines.length,
      };
      const { line_total, tax_amount } = calculateLineTotal(seed);
      return { ...seed, line_total, tax_amount };
    },
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invoice) return;

    setIsSubmitting(true);

    try {
      if (!formData.contact_id) {
        throw new Error("Please select a customer for this invoice");
      }
      const result = validateLineItems(lineItems);
      if (!result.ok) {
        throw new Error(result.error);
      }
      const validItems = result.valid;

      const oversellNow = validItems.some((item) => {
        const p = item.product_id ? products.find((pp) => pp.id === item.product_id) : undefined;
        if (!p || !p.track_inventory || p.type === "service") return false;
        return item.quantity > Number((p as any).available ?? p.stock_quantity ?? 0);
      });
      if (oversellNow && !confirmOversell) {
        throw new Error(
          "One or more lines exceed available stock. Tick the oversell confirmation below to proceed.",
        );
      }

      const { subtotal, tax_total: taxAmount, total } = computeTotals(
        validItems,
        formData.discount_amount,
      );

      const { error: invoiceError } = await supabase
        .from("invoices")
        .update({
          contact_id: formData.contact_id || null,
          due_date: formData.due_date,
          notes: formData.notes || null,
          terms: formData.terms || null,
          discount_amount: formData.discount_amount,
          project_id: formData.project_id,
          subtotal,
          tax_amount: taxAmount,
          total,
        })
        .eq("id", invoice.id);

      if (invoiceError) throw invoiceError;

      const { error: deleteError } = await supabase
        .from("invoice_items")
        .delete()
        .eq("invoice_id", invoice.id);

      if (deleteError) throw deleteError;

      const newItems = validItems.map((item, index) => ({
        invoice_id: invoice.id,
        product_id: item.product_id || null,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        tax_amount: item.tax_amount,
        discount_percent: item.discount_percent,
        line_total: item.line_total,
        sort_order: index,
        project_id: item.project_id ?? null,
        task_id: item.task_id ?? null,
        packaging_id: (item as any).packaging_id ?? null,
        display_uom_id: (item as any).display_uom_id ?? null,
        display_quantity: (item as any).display_quantity ?? null,
      }));

      const { error: insertError } = await supabase
        .from("invoice_items")
        .insert(newItems);

      if (insertError) throw insertError;

      toast({ title: "Invoice updated successfully" });
      onOpenChange(false);
      onSuccess();
    } catch (error: any) {
      toast({
        title: "Error updating invoice",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: invoice?.currency || "USD",
    }).format(amount);
  };

  const subtotal = lineItems.reduce((sum, item) => sum + item.line_total, 0);
  const taxTotal = lineItems.reduce((sum, item) => sum + item.tax_amount, 0);
  const grandTotal = subtotal + taxTotal - formData.discount_amount;

  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both");

  const lineStockEvals = lineItems.map((item) => {
    const product = item.product_id ? products.find((p) => p.id === item.product_id) : undefined;
    if (!product) return null;
    return {
      product,
      result: evaluateStock({
        trackInventory: product.track_inventory,
        productType: product.type,
        onHand: (product as any).available ?? product.stock_quantity,
        reorderLevel: product.reorder_level,
        requestedQty: item.quantity,
      }),
    };
  });
  const oversoldLines = lineStockEvals
    .map((e, i) => (e && (e.result.status === "exceeded" || e.result.status === "out") ? { i, ...e } : null))
    .filter(Boolean);
  const hasOversell = oversoldLines.length > 0;

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Invoice"
      recordRef={invoice?.invoice_number}
      meta={invoice ? "Only draft invoices can be edited" : "Loading…"}
      cancelHref={invoice ? `/sales/invoices/${invoice.id}` : "/sales/invoices"}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Save Changes"
    >
      {isLoading || !invoice ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-6">
          <CustomFieldsSection
            entityType="invoice"
            entityId={invoice?.id || null}
            formValues={formData}
            disabled={isSubmitting}
            documentSection="header"
            showHeader={false}
          />

          <FieldGroup label="Customer & Dates">

            <FieldGrid columns={2}>
              <div className="space-y-2">
                <Label htmlFor="customer">Customer</Label>
                <Select
                  value={formData.contact_id}
                  onValueChange={(value) => setFormData({ ...formData, contact_id: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select customer" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="due_date">Due Date *</Label>
                <Input
                  id="due_date"
                  type="date"
                  value={formData.due_date}
                  onChange={(e) => setFormData({ ...formData, due_date: e.target.value })}
                  required
                />
              </div>
            </FieldGrid>
          </FieldGroup>

          <CapabilityGate cap="projects.analytic-tagging">
            <FieldGroup label="Project">
              <ProjectPicker
                enabled={open}
                value={formData.project_id}
                onChange={(id) => setFormData({ ...formData, project_id: id })}
                customerId={formData.contact_id || null}
                helperText="Optional — links this invoice's revenue to project profitability."
              />
            </FieldGroup>
          </CapabilityGate>

          <CustomFieldsSection
            entityType="invoice"
            entityId={invoice?.id || null}
            formValues={formData}
            disabled={isSubmitting}
            documentSection="details"
            showHeader={false}
          />

          <FieldGroup label="Line Items">
            <EditableLineItemsGrid
              columns={INVOICE_LINE_COLUMNS}
              rows={lineItems}
              containerRef={linesTableRef}
              disabled={isSubmitting}
              addLabel="Add Item"
              onAddRow={addLineItem}
              onRemoveRow={removeLineItem}
              toolbar={
                <DocumentLineScanner
                documentLabel="Invoice"
                  businessId={currentBusiness?.id}
                  branchId={currentBranch?.id ?? null}
                  onResolved={handleScanResolved}
                  linesTableRef={linesTableRef}
                  disabled={isSubmitting}
                />
              }
              renderRow={(item, index, layout) => (
                <InvoiceLineRow
                  unitsFor={unitsFor}
                  index={index}
                  item={item}
                  products={products}
                  layout={layout}
                  flashed={flashIndex === index}
                  isSubmitting={isSubmitting}
                  stockEval={lineStockEvals[index] ?? null}
                  headerProjectId={formData.project_id}
                  customerId={formData.contact_id || null}
                  formatCurrency={formatCurrency}
                  onProductSelect={handleProductSelect}
                  onUpdate={updateLineItem}
                />
              )}
            />


            <div className="flex justify-end">
              <div className="w-64 space-y-2">
                <div className="flex justify-between text-sm"><span>Subtotal</span><span>{formatCurrency(subtotal)}</span></div>
                <div className="flex justify-between text-sm"><span>Tax</span><span>{formatCurrency(taxTotal)}</span></div>
                <CustomFieldsSection
                  entityType="invoice"
                  entityId={invoice?.id || null}
                  formValues={formData}
                  disabled={isSubmitting}
                  documentSection="after_items"
                  showHeader={false}
                />
                <div className="flex justify-between items-center text-sm">
                  <span>Discount</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.discount_amount}
                    onChange={(e) => setFormData({ ...formData, discount_amount: parseFloat(e.target.value) || 0 })}
                    className="h-8 w-24 text-right"
                  />
                </div>
                <div className="flex justify-between text-lg font-bold border-t pt-2">
                  <span>Total</span>
                  <span>{formatCurrency(grandTotal)}</span>
                </div>
              </div>
            </div>
          </FieldGroup>

          <FieldGroup label="Additional Info">
            <FieldGrid columns={2}>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="notes">Notes</Label>
                  <AITextAssist
                    fieldType="notes"
                    documentType="invoice"
                    currentValue={formData.notes}
                    onApply={(text) => setFormData({ ...formData, notes: text })}
                    customerName={customers.find(c => c.id === formData.contact_id)?.name}
                    documentNumber={invoice?.invoice_number}
                    totalAmount={grandTotal}
                    currency={invoice?.currency}
                  />
                </div>
                <Textarea id="notes" value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} rows={3} placeholder="Notes visible to customer..." />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="terms">Terms</Label>
                  <AITextAssist
                    fieldType="terms"
                    documentType="invoice"
                    currentValue={formData.terms}
                    onApply={(text) => setFormData({ ...formData, terms: text })}
                    customerName={customers.find(c => c.id === formData.contact_id)?.name}
                    documentNumber={invoice?.invoice_number}
                    totalAmount={grandTotal}
                    currency={invoice?.currency}
                  />
                </div>
                <Textarea id="terms" value={formData.terms} onChange={(e) => setFormData({ ...formData, terms: e.target.value })} rows={3} placeholder="Payment terms..." />
              </div>
            </FieldGrid>
          </FieldGroup>

          <CustomFieldsSection entityType="invoice" entityId={invoice?.id || null} formValues={formData} disabled={isSubmitting} documentSection="notes" showHeader={false} />
          <CustomFieldsSection entityType="invoice" entityId={invoice?.id || null} formValues={formData} disabled={isSubmitting} documentSection={["footer", "additional"]} />

          {hasOversell && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="space-y-2">
                <div className="font-semibold">
                  {oversoldLines.length === 1 ? "1 line exceeds available stock" : `${oversoldLines.length} lines exceed available stock`}
                </div>
                <ul className="text-sm list-disc pl-5 space-y-0.5">
                  {oversoldLines.map((o: any) => (
                    <li key={o.i}><strong>{o.product.name}</strong>: {o.result.message}</li>
                  ))}
                </ul>
                <div className="flex items-start gap-2 pt-2">
                  <Checkbox id="confirmOversellEdit" checked={confirmOversell} onCheckedChange={(c) => setConfirmOversell(c === true)} disabled={isSubmitting} />
                  <Label htmlFor="confirmOversellEdit" className="text-sm font-normal cursor-pointer leading-snug">
                    I confirm overselling — proceed with this invoice even though stock is insufficient.
                  </Label>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </RecordFormShell>

  );
}
