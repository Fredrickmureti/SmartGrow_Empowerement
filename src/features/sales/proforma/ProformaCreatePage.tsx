/**
 * ProformaCreatePage — `/sales/proforma/new`.
 *
 * Phase-3 route replacement for the retired `CreateProformaDialog`.
 * Hosts the same form body on top of `RecordFormShell`.
 *
 * Deep-link params:
 *   ?contact_id=<uuid>   pre-fill customer
 */
import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useProformaInvoices } from "@/hooks/useProformaInvoices";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
import {
  useSalesLineAvailability,
} from "@/features/sales/availability";
import { useCustomerCredit } from "@/hooks/useCustomerCredit";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import { CreditCheckAlert } from "@/components/shared/CreditCheckAlert";
import { computeLine, computeTotals } from "@/lib/invoiceLineMath";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import { validateLineItems } from "@/lib/validation/lineItems";
import { AITextAssist } from "@/components/shared/AITextAssist";
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
import { useUnitsForProducts } from "@/hooks/useSellableUnits";
import { useLinePriceResolver, useServerPriceApplier } from "@/hooks/useLinePriceResolver";

const formSchema = z.object({
  contact_id: z.string().min(1, "Customer is required"),
  issue_date: z.string(),
  valid_until: z.string(),
  notes: z.string().optional(),
  terms: z.string().optional(),
});

interface LineItem {
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
}

export default function ProformaCreatePage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Handheld list pages deep-link here with `openScanSession` so the
  // camera sheet opens immediately (see ScanToDocumentButton).
  const openScanSessionOnMount =
    ((location.state as { openScanSession?: boolean } | null)?.openScanSession) === true;
  const [searchParams] = useSearchParams();
  const prefillContactId = searchParams.get("contact_id") ?? undefined;

  const { createProformaInvoice } = useProformaInvoices();
  const { contacts } = useContacts();
  const { products, branchScopeLabel } = useBranchScopedProducts();
  /** Sell units per product; the server re-derives the base quantity. */
  const unitsFor = useUnitsForProducts(products);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0 },
  ]);

  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both");

  const defaultValidUntil = new Date();
  defaultValidUntil.setDate(defaultValidUntil.getDate() + 30);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      contact_id: prefillContactId || "",
      issue_date: new Date().toISOString().split("T")[0],
      valid_until: defaultValidUntil.toISOString().split("T")[0],
      notes: "",
      terms: "",
    },
  });

  const watchedContactId = form.watch("contact_id");
  const { creditInfo, checkCreditAvailability } = useCustomerCredit(watchedContactId || undefined);

  useEffect(() => {
    if (prefillContactId) form.setValue("contact_id", prefillContactId);
  }, [prefillContactId, form]);

  // Scan-to-line parity — the Sales workspace scan transport is live on every
  // page (SalesLayout mounts SalesScanProvider); this form is a consumer of it.
  const { currentBusiness } = useBusinesses();

  /** Server-authoritative price for a line, previewed in the editor. */
  const resolvePrice = useLinePriceResolver(currentBusiness?.id, watchedContactId || null);
  const applyServerPrice = useServerPriceApplier(lineItems, setLineItems, resolvePrice);
  const { currentBranch } = useBranches();

  const { handleScanResolved, handleScanSessionCommit, flashIndex } = usePricedLineScan(
    setLineItems,
    (resolved, quantity) => ({
      product_id: resolved.productId,
      description: resolved.name,
      quantity,
      unit_price: scanUnitPrice(resolved),
      tax_rate: scanTaxRate(resolved),
    }),
  );

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [
      ...prev,
      { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0 },
    ]);
  }, []);

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }, []);

  const patchLineItem = useCallback((index: number, patch: Partial<LineItem>) => {
    // Re-price whenever what the customer buys changes (unit or pack).
    if ((patch as Record<string, unknown>).packaging_id !== undefined || (patch as Record<string, unknown>).display_uom_id !== undefined) {
      void applyServerPrice(index, patch as never);
    }
    setLineItems((prev) =>
      prev.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }, [applyServerPrice]);

  const selectProduct = useCallback(
    (index: number, productId: string) => {
      const product = products.find((p) => p.id === productId);
      setLineItems((prev) =>
        prev.map((line, i) =>
          i === index
            ? {
                ...line,
                product_id: productId,
                description: product?.name ?? line.description,
                unit_price: product?.unit_price ?? line.unit_price,
                tax_rate: product?.tax_rate ?? 0,
              }
            : line,
        ),
      );
      // Product scalar is an optimistic placeholder; the server resolver
      // (price list > price book > product) is the authority and is what the
      // database stamps on insert.
      void applyServerPrice(index, { product_id: productId });
    },
    [products, applyServerPrice],
  );

  const formatLineCurrency = useCallback((n: number) => n.toFixed(2), []);


  // Canonical line math — same helper the invoice/estimate paths use, and the
  // same semantics `create_proforma_atomic` recomputes with server-side.
  const calculateTotals = () => {
    const { subtotal, tax_total, total } = computeTotals(lineItems.map((item) => computeLine(item)));
    return { subtotal, taxAmount: tax_total, total };
  };

  const totals = calculateTotals();

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    const validation = validateLineItems(lineItems);
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }
    const validatedLines = validation.valid;

    setIsSubmitting(true);
    try {
      const computed = validatedLines.map((item) => ({ item, calc: computeLine(item) }));
      const { subtotal, tax_total: taxAmount, total } = computeTotals(computed.map((c) => c.calc));

      if (creditInfo) {
        const creditResult = checkCreditAvailability(total);
        if (!creditResult.allowed) {
          toast.error(creditResult.reason || "Credit check failed");
          setIsSubmitting(false);
          return;
        }
      }

      const items = computed.map(({ item, calc }) => ({
        product_id: item.product_id,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        discount_percent: (item as { discount_percent?: number }).discount_percent ?? 0,
        tax_amount: calc.tax_amount,
        line_total: calc.line_total,
      }));

      const created = await createProformaInvoice(
        {
          contact_id: values.contact_id,
          issue_date: values.issue_date,
          expiry_date: values.valid_until,
          notes: values.notes,
          terms: values.terms,
          subtotal,
          tax_amount: taxAmount,
          total,
          status: "draft",
        },
        items,
      );

      if (created?.id) {
        navigate(`/sales/proforma/${created.id}`);
      } else {
        navigate("/sales/proforma");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Proforma Invoice"
      meta={
        <>
          Create a preliminary invoice for customer approval · Stock shown for:{" "}
          <span className="font-medium text-foreground">{branchScopeLabel}</span>
        </>
      }
      cancelHref="/sales/proforma"
      onSubmit={form.handleSubmit(onSubmit)}
      isSubmitting={isSubmitting}
      submitDisabled={!watchedContactId}
      submitLabel="Create Proforma Invoice"
    >
      <Form {...form}>
        <div className="space-y-6 min-w-0">
          <CreditCheckAlert customerId={watchedContactId || undefined} orderAmount={totals.total} />

          <FieldGroup label="Customer & Dates">
            <FieldGrid columns={2}>
              <FormField
                control={form.control}
                name="contact_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Customer *</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={async (v) => {
                        field.onChange(v);
                        try {
                          const defaults = await fetchContactDefaults(v);
                          if (defaults.tax_exemption_number) {
                            setLineItems((prev) => prev.map((item) => ({ ...item, tax_rate: 0 })));
                          } else if (defaults.default_tax_rate_id) {
                            const { data: taxRate } = await supabase
                              .from("tax_rates")
                              .select("rate")
                              .eq("id", defaults.default_tax_rate_id)
                              .maybeSingle();
                            if (taxRate?.rate != null) {
                              setLineItems((prev) => prev.map((item) => ({ ...item, tax_rate: taxRate.rate })));
                            }
                          }
                        } catch (e) {
                          console.error("Failed to fetch contact defaults:", e);
                        }
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select customer" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {customers.map((contact) => (
                          <SelectItem key={contact.id} value={contact.id}>{contact.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="issue_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Issue Date</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="valid_until"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Valid Until</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGrid>
          </FieldGroup>

          <FieldGroup label="Line Items">
            <EditableLineItemsGrid
              columns={PRICED_LINE_COLUMNS}
              rows={lineItems}
              toolbar={
                <DocumentLineScanner
                  documentLabel="Proforma"
                  businessId={currentBusiness?.id}
                  branchId={currentBranch?.id ?? null}
                  onResolved={handleScanResolved}
                  onSessionCommit={handleScanSessionCommit}
                  openSessionOnMount={openScanSessionOnMount}
                />
              }
              onAddRow={addLineItem}
              onRemoveRow={removeLineItem}
              addLabel="Add Item"
              renderRow={(item, index, layout) => (
                <PricedLineRow
                  unitsFor={unitsFor}
                  key={index}
                  index={index}
                  item={item}
                  flashed={flashIndex === index}
                  products={products}
                  layout={layout}
                  formatCurrency={formatLineCurrency}
                  onPatch={patchLineItem}
                  onProductSelect={selectProduct}
                />
              )}
              footer={
                <div className="flex justify-end">
                  <div className="w-64 space-y-2">
                    <div className="flex justify-between text-sm"><span>Subtotal:</span><span>{totals.subtotal.toFixed(2)}</span></div>
                    <div className="flex justify-between text-sm"><span>Tax:</span><span>{totals.taxAmount.toFixed(2)}</span></div>
                    <div className="flex justify-between font-medium border-t pt-2"><span>Total:</span><span>{totals.total.toFixed(2)}</span></div>
                  </div>
                </div>
              }
            />
          </FieldGroup>


          <FieldGroup label="Additional Info">
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>Notes</FormLabel>
                    <AITextAssist
                      fieldType="notes"
                      documentType="proforma"
                      currentValue={field.value || ""}
                      onApply={(text) => field.onChange(text)}
                      customerName={customers.find((c) => c.id === form.getValues("contact_id"))?.name}
                      totalAmount={totals.total}
                    />
                  </div>
                  <FormControl><Textarea {...field} placeholder="Additional notes..." /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="terms"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>Terms & Conditions</FormLabel>
                    <AITextAssist
                      fieldType="terms"
                      documentType="proforma"
                      currentValue={field.value || ""}
                      onApply={(text) => field.onChange(text)}
                      customerName={customers.find((c) => c.id === form.getValues("contact_id"))?.name}
                      totalAmount={totals.total}
                    />
                  </div>
                  <FormControl><Textarea {...field} placeholder="Terms and conditions..." /></FormControl>
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
