// @ts-nocheck
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
import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useSalesOrders } from "@/hooks/useSalesOrders";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
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
import { NumericInput } from "@/components/ui/numeric-input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2 } from "lucide-react";
import { validateLineItems } from "@/lib/validation/lineItems";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { AITextAssist } from "@/components/shared/AITextAssist";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { CapabilityGate } from "@/components/apps/CapabilityGate";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import { ProductCombobox } from "@/components/common/ProductCombobox";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";

const formSchema = z.object({
  contact_id: z.string().min(1, "Customer is required"),
  order_date: z.string(),
  expected_date: z.string().optional(),
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
  const [searchParams] = useSearchParams();
  const prefillContactId = searchParams.get("contact_id") ?? undefined;
  const prefillProjectId = searchParams.get("project_id") ?? undefined;

  const { createSalesOrder } = useSalesOrders();
  const { contacts } = useContacts();
  const { products, branchScopeLabel } = useBranchScopedProducts();
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

  const addLineItem = () => {
    setLineItems([...lineItems, { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0 }]);
  };

  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) setLineItems(lineItems.filter((_, i) => i !== index));
  };

  const updateLineItem = (index: number, field: keyof LineItem, value: any) => {
    const updated = [...lineItems];
    updated[index] = { ...updated[index], [field]: value };
    if (field === "product_id" && value) {
      const product = products.find((p) => p.id === value);
      if (product) {
        updated[index].description = product.name;
        updated[index].unit_price = product.unit_price;
        updated[index].tax_rate = product.tax_rate || 0;
      }
    }
    setLineItems(updated);
  };

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
              <FormField
                control={form.control}
                name="shipping_address"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Shipping Address</FormLabel>
                    <FormControl><Input {...field} placeholder="Enter shipping address" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
            <div className="flex items-center justify-between mb-1">
              <span />
              <Button type="button" variant="outline" size="sm" onClick={addLineItem}>
                <Plus className="h-4 w-4 mr-1" /> Add Item
              </Button>
            </div>

            <div className="space-y-3">
              {lineItems.map((item, index) => (
                <div
                  key={index}
                  className="line-item-card sm:p-0 sm:border-0 sm:rounded-none sm:space-y-0 sm:grid sm:grid-cols-12 sm:gap-2 sm:items-end"
                >
                  <div className="sm:col-span-4">
                    <label className="text-xs text-muted-foreground">Product</label>
                    <ProductCombobox
                      products={products}
                      value={item.product_id}
                      onChange={(v) => updateLineItem(index, "product_id", v)}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="text-xs text-muted-foreground">Description</label>
                    <Input
                      value={item.description}
                      onChange={(e) => updateLineItem(index, "description", e.target.value)}
                      placeholder="Description"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:contents">
                    <div className="sm:col-span-1">
                      <label className="text-xs text-muted-foreground">Qty</label>
                      <PackagedQtyCell
                        productId={item.product_id}
                        value={item as any}
                        onChange={(patch) => setLineItems((prev) => prev.map((it, i) => i === index ? { ...it, ...patch } : it))}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="text-xs text-muted-foreground">Unit Price</label>
                      <NumericInput value={item.unit_price} onValueChange={(v) => updateLineItem(index, "unit_price", v ?? 0)} />
                    </div>
                    <div className="sm:col-span-1">
                      <label className="text-xs text-muted-foreground">Tax %</label>
                      <NumericInput value={item.tax_rate} onValueChange={(v) => updateLineItem(index, "tax_rate", v ?? 0)} />
                    </div>
                  </div>
                  <div className="sm:col-span-1 flex justify-end sm:block">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeLineItem(index)}
                      disabled={lineItems.length === 1}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

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
