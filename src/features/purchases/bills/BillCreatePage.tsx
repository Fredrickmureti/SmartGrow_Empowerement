/**
 * BillCreatePage — full-page create route at `/purchases/bills/new`.
 *
 * Retires the last Bills create dialog by hosting supplier, dates, line
 * items, totals, analytics, and notes on the enterprise RecordFormShell.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { FieldGrid, FieldGroup, RecordFormShell } from "@/design-system";
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
import { ProductCombobox } from "@/components/common/ProductCombobox";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { LineAnalyticsCell } from "@/components/projects/LineAnalyticsCell";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { supabase } from "@/integrations/supabase/client";
import { useBills, type Bill, type BillItem } from "@/hooks/useBills";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { usePaymentTerms } from "@/hooks/usePaymentTerms";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import { normalizeError } from "@/services/resilience";

type LineItem = Omit<BillItem, "id" | "bill_id"> & {
  project_id?: string | null;
  task_id?: string | null;
};

const emptyLine = (sortOrder = 0): LineItem => ({
  account_id: null,
  product_id: null,
  description: "",
  quantity: 1,
  unit_price: 0,
  tax_rate: 0,
  tax_amount: 0,
  line_total: 0,
  sort_order: sortOrder,
  project_id: null,
  task_id: null,
});

export default function BillCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillContactId = searchParams.get("contact_id") ?? "";
  const prefillProjectId = searchParams.get("project_id");
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency, baseCurrency } = useCurrency();
  const { paymentTerms } = usePaymentTerms();
  const { getNextBillNumber, createBill, getDefaultDueDate } = useBills();

  const today = new Date().toISOString().split("T")[0];
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    vendor_id: prefillContactId,
    vendor_invoice_number: "",
    bill_date: today,
    due_date: getDefaultDueDate(today),
    notes: "",
    discount_amount: 0,
    payment_term_id: "",
    project_id: prefillProjectId,
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine(0)]);

  const vendors = contacts.filter(
    (c) => (c.type === "supplier" || c.type === "both") && c.is_active,
  );

  useEffect(() => {
    if (prefillContactId) {
      void handleVendorChange(prefillContactId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillContactId]);

  const calculateLineTotal = (item: LineItem) => {
    const subtotal = item.quantity * item.unit_price;
    const tax = subtotal * ((item.tax_rate || 0) / 100);
    return { lineTotal: subtotal, taxAmount: tax };
  };

  const updateLineItem = (index: number, field: string, value: unknown) => {
    setLineItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value } as LineItem;

      if (field === "product_id" && value) {
        const product = products.find((p) => p.id === value);
        if (product) {
          updated[index].description = product.name;
          updated[index].unit_price = product.cost_price || product.unit_price;
          updated[index].tax_rate = product.tax_rate || 0;
        }
      }

      const { lineTotal, taxAmount } = calculateLineTotal(updated[index]);
      updated[index].line_total = lineTotal;
      updated[index].tax_amount = taxAmount;
      return updated;
    });
  };

  const addLineItem = () =>
    setLineItems((prev) => [...prev, emptyLine(prev.length)]);

  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) {
      setLineItems((prev) => prev.filter((_, i) => i !== index));
    }
  };

  const handleVendorChange = async (vendorId: string) => {
    setFormData((prev) => ({ ...prev, vendor_id: vendorId }));
    if (!vendorId) return;
    try {
      const defaults = await fetchContactDefaults(vendorId);
      if (defaults.default_tax_rate_id) {
        const { data: taxRate } = await supabase
          .from("tax_rates")
          .select("rate")
          .eq("id", defaults.default_tax_rate_id)
          .maybeSingle();
        if (taxRate?.rate != null) {
          setLineItems((prev) =>
            prev.map((item) => {
              const next = { ...item, tax_rate: taxRate.rate };
              const calc = calculateLineTotal(next);
              return {
                ...next,
                line_total: calc.lineTotal,
                tax_amount: calc.taxAmount,
              };
            }),
          );
        }
      }
    } catch (error) {
      console.error("Failed to fetch vendor defaults:", error);
    }
  };

  const handlePaymentTermChange = (termId: string) => {
    setFormData((prev) => {
      const term = paymentTerms.find((t) => t.id === termId);
      if (!term || !prev.bill_date) return { ...prev, payment_term_id: termId };
      const dueDate = new Date(prev.bill_date);
      dueDate.setDate(dueDate.getDate() + term.days);
      return {
        ...prev,
        payment_term_id: termId,
        due_date: dueDate.toISOString().split("T")[0],
      };
    });
  };

  const subtotal = lineItems.reduce((sum, item) => sum + item.line_total, 0);
  const totalTax = lineItems.reduce((sum, item) => sum + item.tax_amount, 0);
  const grandTotal = subtotal + totalTax - formData.discount_amount;
  const validItems = lineItems.filter((item) => item.description.trim());

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!formData.vendor_id || validItems.length === 0) {
      toast.error("Select a supplier and add at least one bill line");
      return;
    }
    setIsSubmitting(true);
    try {
      const billNumber = await getNextBillNumber();
      const created = await createBill(
        {
          bill_number: billNumber,
          vendor_id: formData.vendor_id,
          vendor_invoice_number: formData.vendor_invoice_number || null,
          account_id: null,
          status: "received",
          bill_date: formData.bill_date,
          due_date: formData.due_date,
          subtotal: 0,
          tax_amount: 0,
          discount_amount: formData.discount_amount,
          total: 0,
          amount_paid: 0,
          currency: baseCurrency,
          notes: formData.notes || null,
          attachment_url: null,
          project_id: formData.project_id,
        } as Omit<Bill, "id" | "organization_id" | "business_id" | "branch_id" | "created_at" | "updated_at" | "created_by" | "vendor" | "items" | "currency_rate" | "company_currency_total">,
        validItems,
      );
      toast.success("Bill created");
      navigate(created?.id ? `/purchases/bills/${created.id}` : "/purchases/bills");
    } catch (error) {
      toast.error(normalizeError(error).message || "Failed to create bill");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Bill"
      meta="Record a supplier invoice and post it to accounts payable"
      cancelHref="/purchases/bills"
      onSubmit={onSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!formData.vendor_id || validItems.length === 0}
      submitLabel="Create Bill"
    >
      <FieldGroup label="Supplier & dates">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Supplier *</Label>
            <Select value={formData.vendor_id} onValueChange={handleVendorChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select supplier" />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((vendor) => (
                  <SelectItem key={vendor.id} value={vendor.id}>
                    {vendor.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Vendor invoice #</Label>
            <Input
              value={formData.vendor_invoice_number}
              onChange={(event) =>
                setFormData({ ...formData, vendor_invoice_number: event.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Bill date</Label>
            <Input
              type="date"
              value={formData.bill_date}
              onChange={(event) =>
                setFormData({
                  ...formData,
                  bill_date: event.target.value,
                  due_date: formData.payment_term_id
                    ? formData.due_date
                    : getDefaultDueDate(event.target.value),
                })
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Payment terms</Label>
            <Select
              value={formData.payment_term_id}
              onValueChange={handlePaymentTermChange}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select terms" />
              </SelectTrigger>
              <SelectContent>
                {paymentTerms.map((term) => (
                  <SelectItem key={term.id} value={term.id}>
                    {term.name} ({term.days} days)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Due date</Label>
            <Input
              type="date"
              value={formData.due_date}
              onChange={(event) =>
                setFormData({ ...formData, due_date: event.target.value })
              }
            />
          </div>
          <div className="md:col-span-2">
            <ProjectPicker
              enabled
              value={formData.project_id}
              onChange={(projectId) =>
                setFormData({ ...formData, project_id: projectId })
              }
              helperText="Optional — links this bill's costs to project profitability."
            />
          </div>
        </FieldGrid>
      </FieldGroup>

      <FieldGroup label="Line items">
        <div className="mb-1 flex items-center justify-end">
          <Button type="button" variant="outline" size="sm" onClick={addLineItem}>
            <Plus className="mr-1 h-3 w-3" /> Add item
          </Button>
        </div>
        <div className="space-y-3">
          {lineItems.map((item, index) => (
            <div
              key={index}
              className="grid grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-12 sm:items-start sm:border-0 sm:p-0"
            >
              <div className="space-y-2 sm:col-span-4">
                <Label className="text-xs text-muted-foreground sm:hidden">Product</Label>
                <ProductCombobox
                  products={products}
                  value={item.product_id}
                  onChange={(value) => updateLineItem(index, "product_id", value)}
                  placeholder="Product (optional)"
                />
                <LineAnalyticsCell
                  projectId={item.project_id ?? null}
                  taskId={item.task_id ?? null}
                  headerProjectId={formData.project_id}
                  onChange={(next) => {
                    updateLineItem(index, "project_id", next.project_id);
                    updateLineItem(index, "task_id", next.task_id);
                  }}
                  disabled={isSubmitting}
                />
              </div>
              <div className="sm:col-span-3">
                <Label className="text-xs text-muted-foreground sm:hidden">Description</Label>
                <Input
                  placeholder="Description"
                  value={item.description}
                  onChange={(event) =>
                    updateLineItem(index, "description", event.target.value)
                  }
                />
              </div>
              <div className="grid grid-cols-3 gap-2 sm:contents">
                <div className="sm:col-span-1">
                  <Label className="text-xs text-muted-foreground sm:hidden">Qty</Label>
                  <PackagedQtyCell
                    productId={item.product_id}
                    value={item}
                    onChange={(patch) =>
                      setLineItems((prev) => {
                        const next = [...prev];
                        const merged = { ...next[index], ...patch };
                        const { lineTotal, taxAmount } = calculateLineTotal(merged);
                        next[index] = {
                          ...merged,
                          line_total: lineTotal,
                          tax_amount: taxAmount,
                        };
                        return next;
                      })
                    }
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground sm:hidden">Unit price</Label>
                  <Input
                    type="number"
                    value={item.unit_price}
                    onChange={(event) =>
                      updateLineItem(index, "unit_price", parseFloat(event.target.value) || 0)
                    }
                  />
                </div>
                <div className="sm:col-span-1">
                  <Label className="text-xs text-muted-foreground sm:hidden">Tax %</Label>
                  <Input
                    type="number"
                    value={item.tax_rate}
                    onChange={(event) =>
                      updateLineItem(index, "tax_rate", parseFloat(event.target.value) || 0)
                    }
                  />
                </div>
              </div>
              <div className="flex justify-end sm:col-span-1">
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

        <div className="mt-6 flex justify-end">
          <div className="w-72 space-y-2 text-sm">
            <div className="flex justify-between">
              <span>Subtotal:</span>
              <span className="tabular-nums">{formatCurrency(subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span>Tax:</span>
              <span className="tabular-nums">{formatCurrency(totalTax)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label className="shrink-0">Discount:</Label>
              <Input
                type="number"
                className="h-8 w-28"
                value={formData.discount_amount}
                onChange={(event) =>
                  setFormData({
                    ...formData,
                    discount_amount: parseFloat(event.target.value) || 0,
                  })
                }
              />
            </div>
            <div className="flex justify-between border-t pt-2 text-lg font-bold">
              <span>Total:</span>
              <span className="tabular-nums">{formatCurrency(grandTotal)}</span>
            </div>
          </div>
        </div>
      </FieldGroup>

      <FieldGroup label="Notes">
        <Textarea
          value={formData.notes}
          onChange={(event) => setFormData({ ...formData, notes: event.target.value })}
          placeholder="Internal notes…"
        />
      </FieldGroup>

      <CustomFieldsSection entityType="bill" entityId={null} />
    </RecordFormShell>
  );
}