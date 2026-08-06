// @ts-nocheck
/**
 * PurchaseOrderCreatePage — `/purchases/orders/new`.
 *
 * Enterprise UX Standardization: retires the inline "Create Purchase
 * Order" dialog on `src/pages/PurchaseOrders.tsx` and hosts the same
 * form body on top of `RecordFormShell` — matches the sales-orders
 * recipe end-to-end (header, sectioned FieldGrid body, sticky footer).
 *
 * Deep-link params:
 *   ?contact_id=<uuid>   pre-fill vendor
 *   ?project_id=<uuid>   pre-fill project (persisted onto the PO)
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProductCombobox } from "@/components/common/ProductCombobox";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";

import { supabase } from "@/integrations/supabase/client";
import { usePurchaseOrders, type PurchaseOrderItem } from "@/hooks/usePurchaseOrders";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useVendorPriceLists } from "@/hooks/useVendorPriceLists";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import { normalizeError } from "@/services/resilience";

type LineItem = Omit<PurchaseOrderItem, "id" | "purchase_order_id">;

const emptyLine = (sort_order = 0): LineItem => ({
  product_id: null,
  description: "",
  quantity: 1,
  quantity_received: 0,
  unit_price: 0,
  tax_rate: 0,
  tax_amount: 0,
  line_total: 0,
  sort_order,
});

export default function PurchaseOrderCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillContactId =
    searchParams.get("contact_id") ?? searchParams.get("vendor") ?? "";
  const prefillProjectId = searchParams.get("project_id");
  const prefillProductId = searchParams.get("product");

  const { getNextPONumber, createPurchaseOrder } = usePurchaseOrders();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency, baseCurrency } = useCurrency();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    vendor_id: prefillContactId,
    order_date: new Date().toISOString().split("T")[0],
    expected_date: "",
    shipping_address: "",
    notes: "",
    discount_amount: 0,
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine(0)]);

  useEffect(() => {
    if (prefillContactId) setFormData((p) => ({ ...p, vendor_id: prefillContactId }));
  }, [prefillContactId]);

  // Prefill first line with product from query param (once products load)
  useEffect(() => {
    if (!prefillProductId || products.length === 0) return;
    const product = products.find((p) => p.id === prefillProductId);
    if (!product) return;
    setLineItems((prev) => {
      const first = prev[0];
      if (!first || first.product_id) return prev;
      const unit_price = product.cost_price || product.unit_price || 0;
      const next = [...prev];
      next[0] = {
        ...first,
        product_id: product.id,
        description: product.name,
        unit_price,
        tax_rate: product.tax_rate || 0,
      };
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillProductId, products.length]);

  const { priceLists } = useVendorPriceLists(formData.vendor_id || undefined);

  const vendors = contacts.filter(
    (c) => (c.type === "supplier" || c.type === "both") && c.is_active,
  );

  const calculateLineTotal = (item: LineItem) => {
    const subtotal = item.quantity * item.unit_price;
    const tax = subtotal * (item.tax_rate / 100);
    return { lineTotal: subtotal, taxAmount: tax };
  };

  const updateLineItem = (index: number, field: string, value: any) => {
    const updated = [...lineItems];
    updated[index] = { ...updated[index], [field]: value } as LineItem;

    if (field === "product_id" && value) {
      const product = products.find((p) => p.id === value);
      const vendorPrice = priceLists.find((pl) => pl.product_id === value);
      if (product) {
        updated[index].description = product.name;
        updated[index].unit_price = vendorPrice
          ? vendorPrice.unit_price
          : product.cost_price || product.unit_price;
        updated[index].tax_rate = product.tax_rate || 0;
      }
    }

    const { lineTotal, taxAmount } = calculateLineTotal(updated[index]);
    updated[index].line_total = lineTotal;
    updated[index].tax_amount = taxAmount;
    setLineItems(updated);
  };

  const addLineItem = () =>
    setLineItems((prev) => [...prev, emptyLine(prev.length)]);

  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) {
      setLineItems(lineItems.filter((_, i) => i !== index));
    }
  };

  const handleVendorChange = async (v: string) => {
    setFormData((p) => ({ ...p, vendor_id: v }));
    try {
      const defaults = await fetchContactDefaults(v);
      if (defaults.default_tax_rate_id) {
        const { data: taxRate } = await supabase
          .from("tax_rates")
          .select("rate")
          .eq("id", defaults.default_tax_rate_id)
          .maybeSingle();
        if (taxRate?.rate != null) {
          setLineItems((prev) =>
            prev.map((item) => {
              const updated = { ...item, tax_rate: taxRate.rate };
              const calc = calculateLineTotal(updated);
              return { ...updated, line_total: calc.lineTotal, tax_amount: calc.taxAmount };
            }),
          );
        }
      }
    } catch (e) {
      console.error("Failed to fetch vendor defaults:", e);
    }
  };

  const subtotal = lineItems.reduce((s, i) => s + i.line_total, 0);
  const totalTax = lineItems.reduce((s, i) => s + i.tax_amount, 0);
  const grandTotal = subtotal + totalTax - (formData.discount_amount || 0);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.vendor_id || lineItems.every((item) => !item.description)) {
      toast.error("Please fill required fields");
      return;
    }
    setIsSubmitting(true);
    try {
      const poNumber = await getNextPONumber();
      const created = await createPurchaseOrder(
        {
          po_number: poNumber,
          vendor_id: formData.vendor_id,
          project_id: prefillProjectId || null,
          status: "draft",
          order_date: formData.order_date,
          expected_date: formData.expected_date || null,
          subtotal: 0,
          tax_amount: 0,
          discount_amount: formData.discount_amount,
          total: 0,
          currency: baseCurrency,
          shipping_address: formData.shipping_address || null,
          notes: formData.notes || null,
          converted_bill_id: null,
          converted_at: null,
        } as any,
        lineItems.filter((item) => item.description),
      );
      toast.success("Purchase order created");
      navigate(created?.id ? `/purchases/orders/${created.id}` : "/purchases/orders");
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to create PO");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Purchase Order"
      meta="Create a new order to a supplier"
      cancelHref="/purchases/orders"
      onSubmit={onSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!formData.vendor_id}
      submitLabel="Create Purchase Order"
    >
      <FieldGroup label="Vendor & Dates">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Supplier *</Label>
            <Select value={formData.vendor_id} onValueChange={handleVendorChange}>
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
            <Label>Order Date</Label>
            <Input
              type="date"
              value={formData.order_date}
              onChange={(e) => setFormData({ ...formData, order_date: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Expected Delivery</Label>
            <Input
              type="date"
              value={formData.expected_date}
              onChange={(e) => setFormData({ ...formData, expected_date: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Shipping Address</Label>
            <Input
              value={formData.shipping_address}
              onChange={(e) => setFormData({ ...formData, shipping_address: e.target.value })}
              placeholder="Delivery address"
            />
          </div>
        </FieldGrid>
      </FieldGroup>

      <FieldGroup label="Line Items">
        <EditableLineItemsGrid
          columns={PRICED_LINE_COLUMNS}
          rows={lineItems}
          onAddRow={addLineItem}
          onRemoveRow={removeLineItem}
          addLabel="Add Item"
          renderRow={(item, index, layout) => (
            <PricedLineRow
              key={index}
              index={index}
              item={item}
              products={products}
              layout={layout}
              formatCurrency={formatCurrency}
              onPatch={patchLineItem}
              onProductSelect={selectProduct}
              productPlaceholder="Product"
            />
          )}
          footer={
            <div className="flex justify-end">
              <div className="w-64 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span>Subtotal:</span>
                  <span>{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Tax:</span>
                  <span>{formatCurrency(totalTax)}</span>
                </div>
                <div className="flex justify-between font-bold text-lg border-t pt-2">
                  <span>Total:</span>
                  <span>{formatCurrency(grandTotal)}</span>
                </div>
              </div>
            </div>
          }
        />
      </FieldGroup>


      <FieldGroup label="Additional Info">
        <div className="space-y-2">
          <Label>Notes</Label>
          <Textarea
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            placeholder="Order notes..."
          />
        </div>

        <CustomFieldsSection
          entityType="purchase_order"
          entityId={null}
          formValues={formData}
          disabled={isSubmitting}
        />
      </FieldGroup>
    </RecordFormShell>
  );
}