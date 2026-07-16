// @ts-nocheck
/**
 * DeliveryNoteCreatePage — `/sales/delivery-notes/new`.
 *
 * Phase-3 route replacement for the retired `CreateDeliveryNoteDialog`.
 * Hosts the same form body on top of `RecordFormShell`.
 *
 * Deep-link params:
 *   ?contact_id=<uuid>   pre-fill customer
 */
import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useDeliveryNotes } from "@/hooks/useDeliveryNotes";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
import { OutboundLineTracking } from "@/components/inventory/OutboundLineTracking";
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
import { toast } from "sonner";
import { validateLineItems } from "@/lib/validation/lineItems";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";

const formSchema = z.object({
  contact_id: z.string().min(1, "Customer is required"),
  delivery_date: z.string(),
  shipping_address: z.string().optional(),
  driver_name: z.string().optional(),
  vehicle_number: z.string().optional(),
  notes: z.string().optional(),
  auto_invoice_on_complete: z.boolean().default(true),
});

interface LineItem {
  product_id: string | null;
  description: string;
  quantity_ordered: number;
  quantity_delivered: number;
  unit_price: number;
  tax_rate: number;
  discount_percent: number;
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
}

export default function DeliveryNoteCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillContactId = searchParams.get("contact_id") ?? undefined;

  const { createDeliveryNote } = useDeliveryNotes();
  const { contacts } = useContacts();
  const { products, branchScopeLabel } = useBranchScopedProducts();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { product_id: null, description: "", quantity_ordered: 1, quantity_delivered: 1, unit_price: 0, tax_rate: 0, discount_percent: 0 },
  ]);

  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both");

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      contact_id: prefillContactId || "",
      delivery_date: new Date().toISOString().split("T")[0],
      shipping_address: "",
      driver_name: "",
      vehicle_number: "",
      notes: "",
      auto_invoice_on_complete: true,
    },
  });

  const watchedContactId = form.watch("contact_id");

  useEffect(() => {
    if (prefillContactId) form.setValue("contact_id", prefillContactId);
  }, [prefillContactId, form]);

  const addLineItem = () => {
    setLineItems([...lineItems, { product_id: null, description: "", quantity_ordered: 1, quantity_delivered: 1, unit_price: 0, tax_rate: 0, discount_percent: 0 }]);
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
        if (!updated[index].unit_price) updated[index].unit_price = Number(product.unit_price) || 0;
        if (!updated[index].tax_rate) updated[index].tax_rate = Number(product.tax_rate) || 0;
      }
    }
    setLineItems(updated);
  };

  const computeLine = (it: LineItem) => {
    const gross = (it.quantity_delivered || 0) * (it.unit_price || 0);
    const afterDiscount = gross * (1 - (it.discount_percent || 0) / 100);
    const tax = afterDiscount * ((it.tax_rate || 0) / 100);
    return { subtotal: afterDiscount, tax, total: afterDiscount + tax };
  };

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    const validation = validateLineItems(lineItems, { quantityKey: "quantity_ordered" });
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }
    const validatedLines = validation.valid;

    if (values.auto_invoice_on_complete) {
      const missing = validatedLines.find((l) => !l.unit_price || l.unit_price <= 0);
      if (missing) {
        toast.error("Every line needs a unit price when 'Bill on confirmation' is on. Turn it off for non-billable deliveries (samples, internal transfers).");
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const items = validatedLines.map((item) => {
        const c = computeLine(item as LineItem);
        return {
          product_id: item.product_id,
          description: item.description,
          quantity_ordered: item.quantity_ordered,
          quantity_delivered: item.quantity_delivered,
          unit_price: item.unit_price || null,
          tax_rate: item.tax_rate || 0,
          tax_amount: c.tax,
          discount_percent: item.discount_percent || 0,
          line_total: c.total,
          packaging_id: item.packaging_id ?? null,
          display_uom_id: item.display_uom_id ?? null,
          display_quantity: item.display_quantity ?? null,
        };
      });

      const created = await createDeliveryNote(
        {
          ...values,
          status: "pending",
        } as any,
        items as any,
      );
      if (created?.id) {
        navigate(`/sales/delivery-notes/${created.id}`);
      } else {
        navigate("/sales/delivery-notes");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Delivery Note"
      meta={
        <>
          Create a delivery note for goods being shipped · Stock shown for:{" "}
          <span className="font-medium text-foreground">{branchScopeLabel}</span>
        </>
      }
      cancelHref="/sales/delivery-notes"
      onSubmit={form.handleSubmit(onSubmit)}
      isSubmitting={isSubmitting}
      submitDisabled={!watchedContactId}
      submitLabel="Create Delivery Note"
    >
      <Form {...form}>
        <div className="space-y-6 min-w-0">
          <FieldGroup label="Delivery Details">
            <FieldGrid columns={2}>
              <FormField
                control={form.control}
                name="contact_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Customer *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
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
                name="delivery_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Delivery Date</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FieldCell span={2}>
                <FormField
                  control={form.control}
                  name="shipping_address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Shipping Address</FormLabel>
                      <FormControl><Input {...field} placeholder="Enter delivery address" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FieldCell>
              <FormField
                control={form.control}
                name="driver_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Driver Name</FormLabel>
                    <FormControl><Input {...field} placeholder="Driver name" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="vehicle_number"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vehicle Number</FormLabel>
                    <FormControl><Input {...field} placeholder="Vehicle registration" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGrid>
          </FieldGroup>

          <FieldGroup label="Items to Deliver">
            <div className="flex items-center justify-between mb-1">
              <span />
              <Button type="button" variant="outline" size="sm" onClick={addLineItem}>
                <Plus className="h-4 w-4 mr-1" /> Add Item
              </Button>
            </div>

            <div className="space-y-3">
              {lineItems.map((item, index) => {
                const c = computeLine(item);
                return (
                  <div key={index} className="border rounded-md p-3 space-y-2">
                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-5">
                        <label className="text-xs text-muted-foreground">Product</label>
                        <Select
                          value={item.product_id || ""}
                          onValueChange={(v) => updateLineItem(index, "product_id", v)}
                        >
                          <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                          <SelectContent>
                            {products.map((product) => (
                              <SelectItem key={product.id} value={product.id}>{product.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-6">
                        <label className="text-xs text-muted-foreground">Description</label>
                        <Input
                          value={item.description}
                          onChange={(e) => updateLineItem(index, "description", e.target.value)}
                          placeholder="Description"
                        />
                      </div>
                      <div className="col-span-1 flex justify-end">
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
                    <div className="grid grid-cols-6 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground">Qty Ordered</label>
                        <NumericInput value={item.quantity_ordered} onValueChange={(v) => updateLineItem(index, "quantity_ordered", v ?? 0)} />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Delivered</label>
                        <PackagedQtyCell
                          productId={item.product_id ?? null}
                          value={{
                            quantity: item.quantity_delivered,
                            packaging_id: item.packaging_id ?? null,
                            display_quantity: item.display_quantity ?? null,
                            display_uom_id: item.display_uom_id ?? null,
                          }}
                          onChange={(patch) => {
                            const updated = [...lineItems];
                            const merged: LineItem = { ...updated[index] };
                            if (patch.quantity !== undefined) merged.quantity_delivered = patch.quantity;
                            if (patch.packaging_id !== undefined) merged.packaging_id = patch.packaging_id;
                            if (patch.display_quantity !== undefined) merged.display_quantity = patch.display_quantity;
                            if (patch.display_uom_id !== undefined) merged.display_uom_id = patch.display_uom_id;
                            if (patch.quantity !== undefined && updated[index].quantity_ordered === updated[index].quantity_delivered) {
                              merged.quantity_ordered = patch.quantity;
                            }
                            updated[index] = merged;
                            setLineItems(updated);
                          }}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Unit Price</label>
                        <NumericInput value={item.unit_price} onValueChange={(v) => updateLineItem(index, "unit_price", v ?? 0)} />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Disc %</label>
                        <NumericInput value={item.discount_percent} onValueChange={(v) => updateLineItem(index, "discount_percent", v ?? 0)} />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Tax %</label>
                        <NumericInput value={item.tax_rate} onValueChange={(v) => updateLineItem(index, "tax_rate", v ?? 0)} />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Line Total</label>
                        <Input value={c.total.toFixed(2)} readOnly className="bg-muted/40" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </FieldGroup>

          <FieldGroup label="Additional Info">
            <FormField
              control={form.control}
              name="auto_invoice_on_complete"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start gap-3 rounded-md border p-3">
                  <FormControl>
                    <input
                      type="checkbox"
                      checked={field.value}
                      onChange={(e) => field.onChange(e.target.checked)}
                      className="mt-1 h-4 w-4"
                    />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>Bill on confirmation</FormLabel>
                    <p className="text-xs text-muted-foreground">
                      When the delivery is marked delivered, a draft invoice for these lines is created automatically in the same transaction. Turn off for samples or internal transfers.
                    </p>
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl><Textarea {...field} placeholder="Delivery instructions or notes..." /></FormControl>
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
