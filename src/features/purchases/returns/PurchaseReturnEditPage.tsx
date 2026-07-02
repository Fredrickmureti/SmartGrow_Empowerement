// @ts-nocheck
/**
 * PurchaseReturnEditPage — `/purchases/returns/:id/edit`.
 *
 * Enterprise UX Standardization (Phase A1): pairs the existing
 * PurchaseReturnCreatePage so every purchase-return record has a full
 * `/new` + `/:id/edit` route on top of RecordFormShell. Only pending
 * returns are editable — the underlying hook enforces this.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { ErrorState, LoadingState } from "@/design-system";
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
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";

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

export default function PurchaseReturnEditPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { purchaseReturns, isLoading, editPurchaseReturn } = usePurchaseReturns();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency, baseCurrency } = useCurrency();

  const pr = useMemo(
    () => purchaseReturns.find((p) => p.id === id) ?? null,
    [purchaseReturns, id],
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [primed, setPrimed] = useState(false);
  const [formData, setFormData] = useState({
    vendor_id: "",
    return_date: new Date().toISOString().split("T")[0],
    reason: "",
    notes: "",
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine(0)]);

  useEffect(() => {
    if (!pr || primed) return;
    setFormData({
      vendor_id: pr.vendor_id ?? "",
      return_date: pr.return_date,
      reason: pr.reason ?? "",
      notes: pr.notes ?? "",
    });
    if (pr.items && pr.items.length > 0) {
      setLineItems(
        pr.items.map((item, idx) => ({
          product_id: item.product_id ?? null,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          line_total: item.line_total,
          sort_order: idx,
          packaging_id: item.packaging_id ?? null,
          display_uom_id: item.display_uom_id ?? null,
          display_quantity: item.display_quantity ?? null,
        })),
      );
    }
    setPrimed(true);
  }, [pr, primed]);

  const vendors = contacts.filter(
    (c) => (c.type === "supplier" || c.type === "both") && c.is_active,
  );

  const updateLineItem = (index: number, field: string, value: any) => {
    const updated = [...lineItems];
    updated[index] = { ...updated[index], [field]: value } as LineItem;
    if (field === "product_id" && value) {
      const product = products.find((p) => p.id === value);
      if (product) {
        updated[index].description = product.name;
        updated[index].unit_price = product.cost_price || product.unit_price;
      }
    }
    updated[index].line_total = updated[index].quantity * updated[index].unit_price;
    setLineItems(updated);
  };

  const addLineItem = () =>
    setLineItems((prev) => [...prev, emptyLine(prev.length)]);
  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) setLineItems(lineItems.filter((_, i) => i !== index));
  };

  const grandTotal = lineItems.reduce((s, i) => s + i.line_total, 0);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pr) return;
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
      await editPurchaseReturn(
        pr.id,
        {
          vendor_id: formData.vendor_id,
          return_date: formData.return_date,
          reason: formData.reason,
          notes: formData.notes || null,
          total: grandTotal,
        } as any,
        lineItems.filter((item) => item.description),
      );
      navigate("/purchases/returns");
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to update return");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading && !pr) {
    return (
      <RecordFormShell
        mode="edit"
        entityLabel="Purchase Return"
        cancelHref="/purchases/returns"
      >
        <LoadingState />
      </RecordFormShell>
    );
  }

  if (!pr) {
    return (
      <RecordFormShell
        mode="edit"
        entityLabel="Purchase Return"
        cancelHref="/purchases/returns"
      >
        <ErrorState
          title="Purchase return not found"
          description="It may have been deleted or you don't have access."
          onRetry={() => navigate("/purchases/returns")}
        />
      </RecordFormShell>
    );
  }

  if (pr.status !== "pending") {
    return (
      <RecordFormShell
        mode="edit"
        entityLabel="Purchase Return"
        cancelHref="/purchases/returns"
      >
        <ErrorState
          title="Purchase return is not editable"
          description={`This return is ${pr.status}. Only pending returns can be edited.`}
          onRetry={() => navigate("/purchases/returns")}
        />
      </RecordFormShell>
    );
  }

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Purchase Return"
      meta={`Edit pending ${pr.return_number}`}
      cancelHref="/purchases/returns"
      onSubmit={onSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!formData.vendor_id || !formData.reason}
      submitLabel="Save Changes"
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
        <div className="flex items-center justify-between mb-1">
          <span />
          <Button type="button" variant="outline" size="sm" onClick={addLineItem}>
            <Plus className="mr-1 h-3 w-3" /> Add Item
          </Button>
        </div>
        <div className="space-y-3">
          {lineItems.map((item, index) => (
            <div
              key={index}
              className="border rounded-lg p-3 space-y-3 sm:border-0 sm:p-0 sm:space-y-0 sm:grid sm:grid-cols-12 sm:gap-2 sm:items-end"
            >
              <div className="sm:col-span-4">
                <Label className="text-xs text-muted-foreground sm:hidden">Product</Label>
                <Select
                  value={item.product_id || ""}
                  onValueChange={(v) => updateLineItem(index, "product_id", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Product" />
                  </SelectTrigger>
                  <SelectContent>
                    {products
                      .filter((p) => p.is_active)
                      .map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-4">
                <Label className="text-xs text-muted-foreground sm:hidden">Description</Label>
                <Input
                  placeholder="Description"
                  value={item.description}
                  onChange={(e) => updateLineItem(index, "description", e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:contents">
                <div className="sm:col-span-1">
                  <Label className="text-xs text-muted-foreground sm:hidden">Qty</Label>
                  <PackagedQtyCell
                    productId={item.product_id}
                    value={item as any}
                    onChange={(patch) =>
                      setLineItems((prev) => {
                        const next = [...prev];
                        const merged = { ...next[index], ...patch };
                        next[index] = {
                          ...merged,
                          line_total: merged.quantity * merged.unit_price,
                        };
                        return next;
                      })
                    }
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground sm:hidden">Price</Label>
                  <NumericInput
                    placeholder="Price"
                    value={item.unit_price}
                    onValueChange={(v) => updateLineItem(index, "unit_price", v ?? 0)}
                  />
                </div>
              </div>
              <div className="sm:col-span-1 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeLineItem(index)}
                  disabled={lineItems.length === 1}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end pt-3">
          <div className="text-lg font-semibold">
            Total: {formatCurrency(grandTotal, baseCurrency)}
          </div>
        </div>
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
