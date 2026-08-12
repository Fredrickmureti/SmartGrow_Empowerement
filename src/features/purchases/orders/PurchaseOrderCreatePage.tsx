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
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { toast } from "sonner";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";
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
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { PricedLineRow, PRICED_LINE_COLUMNS } from "@/components/documents/lines/PricedLineRow";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { DocumentLineScanner } from "@/components/documents/lines/DocumentLineScanner";
import {
  usePricedLineScan,
  scanCostPrice,
  scanTaxRate,
} from "@/features/sales/scan-session/useDocumentLineScan";
import { useBusinesses } from "@/hooks/useBusinesses";
import { DeliverToPicker } from "@/components/addresses/DeliverToPicker";
import { useBranches } from "@/hooks/useBranches";

import { supabase } from "@/integrations/supabase/client";
import { usePurchaseOrders, type PurchaseOrderItem } from "@/hooks/usePurchaseOrders";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useVendorPriceLists } from "@/hooks/useVendorPriceLists";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import { normalizeError } from "@/services/resilience";
import { usePurchasableVendors } from "@/features/purchases/suppliers/usePurchasableVendors";

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
  const location = useLocation();
  // Handheld list pages deep-link here with `openScanSession` so the
  // camera sheet opens immediately (see ScanToDocumentButton).
  const openScanSessionOnMount =
    ((location.state as { openScanSession?: boolean } | null)?.openScanSession) === true;
  const [searchParams] = useSearchParams();
  const prefillContactId =
    searchParams.get("contact_id") ?? searchParams.get("vendor") ?? "";
  const prefillProjectId = searchParams.get("project_id");
  const prefillProductId = searchParams.get("product");

  const { getNextPONumber, createPurchaseOrder } = usePurchaseOrders();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency } = useCurrency();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    vendor_id: prefillContactId,
    order_date: new Date().toISOString().split("T")[0],
    expected_date: "",
    // OUR receiving location (structured), plus the printed snapshot.
    deliver_to_warehouse_id: null as string | null,
    deliver_to_branch_id: null as string | null,
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

  const vendors = usePurchasableVendors(contacts);

  const calculateLineTotal = (item: LineItem) => {
    const subtotal = item.quantity * item.unit_price;
    const tax = subtotal * (item.tax_rate / 100);
    return { lineTotal: subtotal, taxAmount: tax };
  };

  const patchLineItem = useCallback((index: number, patch: Partial<LineItem>) => {
    setLineItems((prev) =>
      prev.map((line, i) => {
        if (i !== index) return line;
        const merged = { ...line, ...patch } as LineItem;
        const subtotal = merged.quantity * merged.unit_price;
        return {
          ...merged,
          line_total: subtotal,
          tax_amount: subtotal * ((merged.tax_rate || 0) / 100),
        };
      }),
    );
  }, []);

  // Scan-to-line — PurchasesLayout mounts the same workspace scan transport
  // Sales uses, so a paired phone / wedge / camera is already live here.
  // Buying documents seed from cost price; the vendor price-list override
  // below stays authoritative.
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { handleScanResolved, handleScanSessionCommit, flashIndex } = usePricedLineScan(
    setLineItems,
    (resolved, quantity, lines) => {
      const unit_price = scanCostPrice(resolved);
      const tax_rate = scanTaxRate(resolved);
      const subtotal = quantity * unit_price;
      return {
        product_id: resolved.productId,
        description: resolved.name,
        quantity,
        quantity_received: 0,
        unit_price,
        tax_rate,
        tax_amount: subtotal * (tax_rate / 100),
        line_total: subtotal,
        sort_order: lines.length,
      } as LineItem;
    },
  );

  const selectProduct = useCallback(
    (index: number, productId: string) => {
      const product = products.find((p) => p.id === productId);
      const vendorPrice = priceLists.find((pl) => pl.product_id === productId);
      patchLineItem(index, {
        product_id: productId,
        ...(product
          ? {
              description: product.name,
              unit_price: vendorPrice
                ? vendorPrice.unit_price
                : product.cost_price || product.unit_price,
              tax_rate: product.tax_rate || 0,
            }
          : {}),
      } as Partial<LineItem>);
    },
    [products, priceLists, patchLineItem],
  );

  const addLineItem = useCallback(
    () => setLineItems((prev) => [...prev, emptyLine(prev.length)]),
    [],
  );

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }, []);


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
          deliver_to_warehouse_id: formData.deliver_to_warehouse_id,
          deliver_to_branch_id: formData.deliver_to_branch_id,
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
          <div className="space-y-2 md:col-span-2">
            <DeliverToPicker
              businessId={currentBusiness?.id}
              value={{
                deliverToWarehouseId: formData.deliver_to_warehouse_id,
                deliverToBranchId: formData.deliver_to_branch_id,
                shippingAddress: formData.shipping_address,
              }}
              onChange={(next) =>
                setFormData((prev) => ({
                  ...prev,
                  deliver_to_warehouse_id: next.deliverToWarehouseId,
                  deliver_to_branch_id: next.deliverToBranchId,
                  shipping_address: next.shippingAddress,
                }))
              }
            />
          </div>
        </FieldGrid>
      </FieldGroup>

      <FieldGroup label="Line Items">
        <EditableLineItemsGrid
          columns={PRICED_LINE_COLUMNS}
          rows={lineItems}
          toolbar={
            <DocumentLineScanner
              documentLabel="Purchase order"
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
              key={index}
              index={index}
              item={item}
              flashed={flashIndex === index}
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