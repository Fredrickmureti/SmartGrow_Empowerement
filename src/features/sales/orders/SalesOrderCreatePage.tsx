/**
 * SalesOrderCreatePage — `/sales/orders/new`.
 *
 * Phase-3 route replacement for the retired `CreateSalesOrderDialog`.
 * Hosts the same form body on top of `RecordFormShell`.
 *
 * Deep-link params:
 *   ?contact_id=<uuid>   pre-fill customer
 *   ?project_id=<uuid>   pre-fill project
 */
import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useSalesOrders } from "@/hooks/useSalesOrders";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
import { useUnitsForProducts } from "@/hooks/useSellableUnits";
import { useLinePriceResolver, useServerPriceApplier } from "@/hooks/useLinePriceResolver";
import { useCustomerCredit } from "@/hooks/useCustomerCredit";
import { usePaymentTerms } from "@/hooks/usePaymentTerms";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import { CreditCheckAlert } from "@/components/shared/CreditCheckAlert";
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
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { AITextAssist } from "@/components/shared/AITextAssist";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { CapabilityGate } from "@/components/apps/CapabilityGate";
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
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { ShipToPicker } from "@/components/addresses/ShipToPicker";

const formSchema = z.object({
  contact_id: z.string().min(1, "Customer is required"),
  order_date: z.string(),
  expected_date: z.string().optional(),
  // Structured link to the customer's saved address (null = custom address).
  ship_to_contact_id: z.string().nullable().optional(),
  // Rendered snapshot printed on the document.
  shipping_address: z.string().optional(),
  notes: z.string().optional(),
  terms: z.string().optional(),
  project_id: z.string().nullable().optional(),
});

interface LineItem {
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  project_id?: string | null;
  task_id?: string | null;
  packaging_id?: string | null;
  display_quantity?: number | null;
  display_uom_id?: string | null;
}

export default function SalesOrderCreatePage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Handheld list pages deep-link here with `openScanSession` so the
  // camera sheet opens immediately (see ScanToDocumentButton).
  const openScanSessionOnMount =
    ((location.state as { openScanSession?: boolean } | null)?.openScanSession) === true;
  const [searchParams] = useSearchParams();
  const prefillContactId = searchParams.get("contact_id") ?? undefined;
  const prefillProjectId = searchParams.get("project_id") ?? undefined;

  const { createSalesOrder } = useSalesOrders();
  const { contacts } = useContacts();
  const { products, branchScopeLabel } = useBranchScopedProducts();
  /** Sell units per product; the server re-derives the base quantity. */
  const unitsFor = useUnitsForProducts(products);
  const { paymentTerms } = usePaymentTerms();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0 },
  ]);

  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both");

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      contact_id: prefillContactId || "",
      order_date: new Date().toISOString().split("T")[0],
      expected_date: "",
      ship_to_contact_id: null,
      shipping_address: "",
      notes: "",
      terms: "",
      project_id: prefillProjectId ?? null,
    },
  });

  const watchedContactId = form.watch("contact_id");
  const { creditInfo, checkCreditAvailability } = useCustomerCredit(watchedContactId || undefined);

  useEffect(() => {
    if (prefillContactId) form.setValue("contact_id", prefillContactId);
    if (prefillProjectId !== undefined) form.setValue("project_id", prefillProjectId ?? null);
  }, [prefillContactId, prefillProjectId, form]);

  // Scan-to-line parity — the Sales workspace scan transport is live on every
  // page (SalesLayout mounts SalesScanProvider); this form is a consumer of it.
  const { currentBusiness } = useBusinesses();
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

  const addLineItem = () => {
    setLineItems([...lineItems, { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0 }]);
  };

  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) setLineItems(lineItems.filter((_, i) => i !== index));
  };

  /** Applies a partial line update, deriving defaults when the product changes. */
  const patchLineItem = useCallback(
    (index: number, patch: Partial<LineItem>) => {
      setLineItems((prev) =>
        prev.map((it, i) => {
          if (i !== index) return it;
          const next = { ...it, ...patch };
          if (patch.product_id) {
            const product = products.find((p) => p.id === patch.product_id);
            if (product) {
              next.description = product.name;
              next.unit_price = product.unit_price;
              next.tax_rate = product.tax_rate || 0;
            }
          }
          return next;
        }),
      );
      // The product scalar above is only an optimistic placeholder; the server
      // resolver (price list > price book > product) has the final word and is
      // what the database will stamp on insert.
      if (patch.product_id || patch.packaging_id !== undefined || patch.display_uom_id !== undefined) {
        void applyServerPrice(index, patch);
      }
    },
    [products, applyServerPrice],
  );

  const formatLineCurrency = useCallback((n: number) => n.toFixed(2), []);


  const calculateTotals = () => {
    const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
    const taxAmount = lineItems.reduce((sum, item) => {
      const lineTotal = item.quantity * item.unit_price;
      return sum + (lineTotal * (item.tax_rate / 100));
    }, 0);
    return { subtotal, taxAmount, total: subtotal + taxAmount };
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
      const subtotal = validatedLines.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      const taxAmount = validatedLines.reduce((sum, item) => sum + (item.quantity * item.unit_price * (item.tax_rate || 0)) / 100, 0);
      const total = subtotal + taxAmount;

      if (creditInfo) {
        const creditResult = checkCreditAvailability(total);
        if (!creditResult.allowed) {
          toast.error(creditResult.reason || "Credit check failed");
          setIsSubmitting(false);
          return;
        }
      }

      const items = validatedLines.map((item) => ({
        product_id: item.product_id,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        tax_amount: (item.quantity * item.unit_price * (item.tax_rate || 0)) / 100,
        line_total: item.quantity * item.unit_price,
        project_id: (item as LineItem).project_id ?? null,
        task_id: (item as LineItem).task_id ?? null,
        packaging_id: (item as LineItem).packaging_id ?? null,
        display_quantity: (item as LineItem).display_quantity ?? null,
        display_uom_id: (item as LineItem).display_uom_id ?? null,
      }));

      const created = await createSalesOrder(
        {
          ...values,
          subtotal,
          tax_amount: taxAmount,
          total,
          status: "draft",
        } as any,
        items as any,
      );
      toast.success("Sales order created");
      navigate(created?.id ? `/sales/orders/${created.id}` : "/sales/orders");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Sales Order"
      meta={
        <>
          Create a new sales order for a customer · Stock shown for:{" "}
          <span className="font-medium text-foreground">{branchScopeLabel}</span>
        </>
      }
      cancelHref="/sales/orders"
      onSubmit={form.handleSubmit(onSubmit)}
      isSubmitting={isSubmitting}
      submitDisabled={!watchedContactId}
      submitLabel="Create Sales Order"
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
                          if (defaults.payment_term_id) {
                            const term = paymentTerms?.find((t) => t.id === defaults.payment_term_id);
                            if (term) form.setValue("terms", term.name);
                          }
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
                name="order_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Order Date</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="expected_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expected Delivery Date</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FieldCell span={2}>
                <ShipToPicker
                  contactId={watchedContactId || null}
                  value={{
                    shipToContactId: form.watch("ship_to_contact_id") ?? null,
                    shippingAddress: form.watch("shipping_address") ?? "",
                  }}
                  onChange={(next) => {
                    form.setValue("ship_to_contact_id", next.shipToContactId, {
                      shouldDirty: true,
                    });
                    form.setValue("shipping_address", next.shippingAddress, {
                      shouldDirty: true,
                    });
                  }}
                />
              </FieldCell>
            </FieldGrid>
          </FieldGroup>

          <CapabilityGate cap="projects.analytic-tagging">
            <FieldGroup label="Shipping & Project">
              <FormField
                control={form.control}
                name="project_id"
                render={({ field }) => (
                  <FormItem>
                    <ProjectPicker
                      enabled={true}
                      value={field.value ?? null}
                      onChange={(id) => field.onChange(id)}
                      customerId={watchedContactId || null}
                      helperText="Optional — links the SO and its eventual invoice to project profitability."
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGroup>
          </CapabilityGate>

          <FieldGroup label="Line Items">
            <EditableLineItemsGrid
              columns={PRICED_LINE_COLUMNS}
              rows={lineItems}
              toolbar={
                <DocumentLineScanner
                  documentLabel="Sales order"
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
                <PricedLineRow
                  index={index}
                  item={item}
                  flashed={flashIndex === index}
                  products={products}
                  layout={layout}
                  formatCurrency={formatLineCurrency}
                  onPatch={patchLineItem}
                  unitsFor={unitsFor}
                />
              )}
            />

            <div className="flex justify-end pt-2">
              <div className="w-64 space-y-2">
                <div className="flex justify-between text-sm"><span>Subtotal:</span><span>{totals.subtotal.toFixed(2)}</span></div>
                <div className="flex justify-between text-sm"><span>Tax:</span><span>{totals.taxAmount.toFixed(2)}</span></div>
                <div className="flex justify-between font-medium border-t pt-2"><span>Total:</span><span>{totals.total.toFixed(2)}</span></div>
              </div>
            </div>
          </FieldGroup>

          <FieldGroup label="Additional Info">
            <FieldGrid columns={2}>
              <FieldCell span={2}>
                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Notes</FormLabel>
                        <AITextAssist
                          fieldType="notes"
                          documentType="sales_order"
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
              </FieldCell>
              <FieldCell span={2}>
                <FormField
                  control={form.control}
                  name="terms"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Terms & Conditions</FormLabel>
                        <AITextAssist
                          fieldType="terms"
                          documentType="sales_order"
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
              </FieldCell>
            </FieldGrid>
          </FieldGroup>

          <CustomFieldsSection
            entityType="sales_order"
            entityId={null}
            formValues={form.getValues()}
            disabled={isSubmitting}
          />
        </div>
      </Form>
    </RecordFormShell>
  );
}
