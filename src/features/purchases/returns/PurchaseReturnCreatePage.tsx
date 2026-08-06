/**
 * PurchaseReturnCreatePage — `/purchases/returns/new`.
 *
 * Enterprise UX Standardization: retires the inline "Create Purchase
 * Return" dialog on `src/pages/PurchaseReturns.tsx`.
 */
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { PricedLineRow, PRICED_LINE_COLUMNS_NO_TAX } from "@/components/documents/lines/PricedLineRow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  usePurchaseReturns,
  type PurchaseReturnItem,
} from "@/hooks/usePurchaseReturns";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { normalizeError } from "@/services/resilience";

type LineItem = Omit<PurchaseReturnItem, "id" | "purchase_return_id">;

const emptyLine = (sort_order = 0): LineItem => ({
  product_id: null,
  description: "",
  quantity: 1,
  unit_price: 0,
  line_total: 0,
  sort_order,
});

export default function PurchaseReturnCreatePage() {
  const navigate = useNavigate();
  const { createPurchaseReturn } = usePurchaseReturns();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency, baseCurrency } = useCurrency();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    vendor_id: "",
    return_date: new Date().toISOString().split("T")[0],
    reason: "",
    notes: "",
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine(0)]);

  const vendors = contacts.filter(
    (c) => (c.type === "supplier" || c.type === "both") && c.is_active,
  );

  const patchLineItem = useCallback((index: number, patch: Partial<LineItem>) => {
    setLineItems((prev) =>
      prev.map((line, i) => {
        if (i !== index) return line;
        const merged = { ...line, ...patch } as LineItem;
        return {
          ...merged,
          line_total: (Number(merged.quantity) || 0) * (Number(merged.unit_price) || 0),
        };
      }),
    );
  }, []);

  const selectProduct = useCallback(
    (index: number, productId: string) => {
      const product = products.find((p) => p.id === productId);
      patchLineItem(index, {
        product_id: productId,
        ...(product
          ? {
              description: product.name,
              unit_price: product.cost_price || product.unit_price,
            }
          : {}),
      } as Partial<LineItem>);
    },
    [products, patchLineItem],
  );

  const formatLineCurrency = useCallback(
    (n: number) => formatCurrency(n, baseCurrency),
    [formatCurrency, baseCurrency],
  );

  const addLineItem = useCallback(
    () => setLineItems((prev) => [...prev, emptyLine(prev.length)]),
    [],
  );

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }, []);

  const grandTotal = lineItems.reduce((s, i) => s + i.line_total, 0);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !formData.vendor_id ||
      !formData.reason ||
      lineItems.every((item) => !item.description)
    ) {
      toast.error("Please fill required fields");
      return;
    }
    setIsSubmitting(true);
    try {
      const created = await createPurchaseReturn(
        {
          vendor_id: formData.vendor_id,
          return_date: formData.return_date,
          reason: formData.reason,
          status: "pending",
          total: 0,
          notes: formData.notes || null,
          purchase_order_id: null,
        } as any,
        lineItems.filter((item) => item.description),
      );
      toast.success("Purchase return created");
      navigate("/purchases/returns");
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to create return");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Purchase Return"
      meta="Return items to a vendor and generate a debit note"
      cancelHref="/purchases/returns"
      onSubmit={onSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!formData.vendor_id || !formData.reason}
      submitLabel="Create Return"
    >
      <FieldGroup label="Return Details">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Supplier *</Label>
            <Select
              value={formData.vendor_id}
              onValueChange={(v) => setFormData({ ...formData, vendor_id: v })}
            >
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
            <Label>Return Date</Label>
            <Input
              type="date"
              value={formData.return_date}
              onChange={(e) => setFormData({ ...formData, return_date: e.target.value })}
            />
          </div>
          <FieldCell span={2}>
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Input
                value={formData.reason}
                onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                placeholder="Reason for return"
              />
            </div>
          </FieldCell>
        </FieldGrid>
      </FieldGroup>

      <FieldGroup label="Line Items">
        <EditableLineItemsGrid
          columns={PRICED_LINE_COLUMNS_NO_TAX}
          rows={lineItems}
          onAddRow={addLineItem}
          onRemoveRow={removeLineItem}
          addLabel="Add Item"
          disabled={isSubmitting}
          renderRow={(item, index, layout) => (
            <PricedLineRow
              key={index}
              index={index}
              item={item}
              products={products.filter((p) => p.is_active)}
              layout={layout}
              disabled={isSubmitting}
              formatCurrency={formatLineCurrency}
              onPatch={patchLineItem}
              onProductSelect={selectProduct}
            />
          )}
          footer={
            <div className="flex justify-end">
              <div className="text-lg font-semibold">
                Total: {formatCurrency(grandTotal, baseCurrency)}
              </div>
            </div>
          }
        />
      </FieldGroup>

      <FieldGroup label="Notes">
        <div className="space-y-2">
          <Textarea
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            placeholder="Additional notes"
          />
        </div>
      </FieldGroup>
    </RecordFormShell>
  );
}