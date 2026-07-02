// @ts-nocheck
/**
 * SalesOrderEditPage — `/sales/orders/:id/edit`.
 *
 * Phase-3 route replacement for the retired `EditSalesOrderDialog`.
 * Only draft sales orders can be edited (RLS + business rule).
 */
import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { validateLineItems } from "@/lib/validation/lineItems";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { LineAnalyticsCell } from "@/components/projects/LineAnalyticsCell";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";
import { normalizeError } from "@/services/resilience";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";

interface LineItem {
  id?: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount: number;
  line_total: number;
  sort_order: number;
  project_id?: string | null;
  task_id?: string | null;
  packaging_id?: string | null;
  display_quantity?: number | null;
  display_uom_id?: string | null;
}

interface OrderData {
  id: string;
  so_number: string;
  contact_id: string | null;
  order_date: string;
  expected_date: string | null;
  shipping_address: string | null;
  notes: string | null;
  terms: string | null;
  status: string;
  currency: string;
}

export default function SalesOrderEditPage() {
  const navigate = useNavigate();
  const { id: orderId } = useParams<{ id: string }>();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [order, setOrder] = useState<OrderData | null>(null);

  const [formData, setFormData] = useState({
    contact_id: "",
    order_date: "",
    expected_date: "",
    shipping_address: "",
    notes: "",
    terms: "",
    project_id: null as string | null,
  });

  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both");

  useEffect(() => {
    if (orderId) loadOrderData(orderId);
  }, [orderId]);

  const loadOrderData = async (id: string) => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("sales_orders")
        .select("*")
        .eq("id", id)
        .single();

      if (error) throw error;
      setOrder(data as OrderData);

      setFormData({
        contact_id: data.contact_id || "",
        order_date: data.order_date || "",
        expected_date: data.expected_date || "",
        shipping_address: data.shipping_address || "",
        notes: data.notes || "",
        terms: data.terms || "",
        project_id: data.project_id ?? null,
      });

      const { data: items, error: itemsError } = await supabase
        .from("sales_order_items")
        .select("*")
        .eq("sales_order_id", id)
        .order("sort_order");

      if (itemsError) throw itemsError;

      setLineItems(
        (items || []).map((item: any) => ({
          id: item.id,
          product_id: item.product_id,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate || 0,
          tax_amount: item.tax_amount || 0,
          line_total: item.line_total,
          sort_order: item.sort_order || 0,
          project_id: item.project_id ?? null,
          task_id: item.task_id ?? null,
          packaging_id: item.packaging_id ?? null,
          display_quantity: item.display_quantity ?? null,
          display_uom_id: item.display_uom_id ?? null,
        }))
      );

      if (!items || items.length === 0) {
        setLineItems([
          { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0, tax_amount: 0, line_total: 0, sort_order: 0 },
        ]);
      }
    } catch (error) {
      console.error("Error loading sales order:", error);
      toast({ title: "Error loading sales order", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const calculateLineTotal = (item: LineItem) => {
    const subtotal = item.quantity * item.unit_price;
    const tax = subtotal * (item.tax_rate / 100);
    return { line_total: subtotal + tax, tax_amount: tax };
  };

  const updateLineItem = (index: number, updates: Partial<LineItem>) => {
    setLineItems((prev) => {
      const newItems = [...prev];
      const updatedItem = { ...newItems[index], ...updates };
      const calculated = calculateLineTotal(updatedItem);
      newItems[index] = { ...updatedItem, ...calculated };
      return newItems;
    });
  };

  const addLineItem = () => {
    setLineItems((prev) => [
      ...prev,
      { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0, tax_amount: 0, line_total: 0, sort_order: prev.length, project_id: null, task_id: null },
    ]);
  };

  const removeLineItem = (index: number) => {
    if (lineItems.length === 1) return;
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleProductSelect = (index: number, productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (product) {
      updateLineItem(index, {
        product_id: productId,
        description: product.name,
        unit_price: product.unit_price,
        tax_rate: product.tax_rate || 0,
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderId || !order) return;

    setIsSubmitting(true);
    try {
      const result = validateLineItems(lineItems);
      if (!result.ok) throw new Error(result.error);
      const validItems = result.valid;

      const subtotal = validItems.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
      const taxAmount = validItems.reduce((sum, item) => sum + item.tax_amount, 0);
      const total = subtotal + taxAmount;

      const { error: soError } = await supabase
        .from("sales_orders")
        .update({
          contact_id: formData.contact_id || null,
          order_date: formData.order_date,
          expected_date: formData.expected_date || null,
          shipping_address: formData.shipping_address || null,
          notes: formData.notes || null,
          terms: formData.terms || null,
          subtotal,
          tax_amount: taxAmount,
          total,
          project_id: formData.project_id,
        })
        .eq("id", orderId);

      if (soError) throw soError;

      await supabase.from("sales_order_items").delete().eq("sales_order_id", orderId);

      const newItems = validItems.map((item, index) => ({
        sales_order_id: orderId,
        product_id: item.product_id || null,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        tax_amount: item.tax_amount,
        line_total: item.line_total,
        sort_order: index,
        project_id: (item as LineItem).project_id ?? null,
        task_id: (item as LineItem).task_id ?? null,
        packaging_id: (item as LineItem).packaging_id ?? null,
        display_quantity: (item as LineItem).display_quantity ?? null,
        display_uom_id: (item as LineItem).display_uom_id ?? null,
      }));

      const { error: insertError } = await supabase.from("sales_order_items").insert(newItems);
      if (insertError) throw insertError;

      toast({ title: "Sales order updated successfully" });
      navigate(`/sales/orders/${orderId}`);
    } catch (error: any) {
      toast({
        title: "Error updating sales order",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const itemsSubtotal = lineItems.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
  const itemsTax = lineItems.reduce((sum, item) => sum + item.tax_amount, 0);
  const grandTotal = itemsSubtotal + itemsTax;
  const currency = order?.currency || "USD"; // architecture-allow: display-only fallback

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Sales Order"
      title={order?.so_number}
      meta={order ? `${order.so_number} • Only draft sales orders can be edited` : "Only draft sales orders can be edited"}
      cancelHref={orderId ? `/sales/orders/${orderId}` : "/sales/orders"}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Save Changes"
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-6 min-w-0">
          <FieldGroup label="Customer & Dates">
            <FieldGrid columns={2}>
              <div className="space-y-2">
                <Label>Customer *</Label>
                <Select
                  value={formData.contact_id}
                  onValueChange={(v) => setFormData({ ...formData, contact_id: v })}
                >
                  <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Order Date *</Label>
                <Input
                  type="date"
                  value={formData.order_date}
                  onChange={(e) => setFormData({ ...formData, order_date: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Expected Delivery Date</Label>
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
                  placeholder="Shipping address..."
                />
              </div>
            </FieldGrid>
          </FieldGroup>

          <FieldGroup label="Shipping & Project">
            <ProjectPicker
              enabled={true}
              value={formData.project_id}
              onChange={(id) => setFormData({ ...formData, project_id: id })}
              customerId={formData.contact_id || null}
              helperText="Optional — links the SO and its eventual invoice to project profitability."
            />
          </FieldGroup>

          <FieldGroup label="Line Items">
            <div className="flex items-center justify-between mb-1">
              <span />
              <Button type="button" variant="outline" size="sm" onClick={addLineItem}>
                <Plus className="mr-2 h-4 w-4" /> Add Item
              </Button>
            </div>

            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[300px]">Description</TableHead>
                    <TableHead className="w-24">Qty</TableHead>
                    <TableHead className="w-28">Price</TableHead>
                    <TableHead className="w-20">Tax %</TableHead>
                    <TableHead className="w-28 text-right">Total</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lineItems.map((item, index) => (
                    <TableRow key={index}>
                      <TableCell>
                        <div className="space-y-2">
                          <ProductCombobox
                            products={products}
                            value={item.product_id}
                            onChange={(value) => handleProductSelect(index, value)}
                            formatCurrency={(n) => formatCurrency(n, currency)}
                          />
                          <Input
                            placeholder="Description"
                            value={item.description}
                            onChange={(e) => updateLineItem(index, { description: e.target.value })}
                            className="h-8"
                          />
                          <LineAnalyticsCell
                            projectId={item.project_id ?? null}
                            taskId={item.task_id ?? null}
                            headerProjectId={formData.project_id}
                            customerId={formData.contact_id || null}
                            onChange={(next) => updateLineItem(index, next)}
                            disabled={isSubmitting}
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                        <PackagedQtyCell
                          productId={item.product_id}
                          value={item as any}
                          onChange={(patch) => updateLineItem(index, patch)}
                          disabled={isSubmitting}
                        />
                      </TableCell>
                      <TableCell>
                        <NumericInput className="h-8" value={item.unit_price} onValueChange={(v) => updateLineItem(index, { unit_price: v ?? 0 })} />
                      </TableCell>
                      <TableCell>
                        <NumericInput className="h-8" value={item.tax_rate} onValueChange={(v) => updateLineItem(index, { tax_rate: v ?? 0 })} />
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(item.line_total, currency)}
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeLineItem(index)}
                          disabled={lineItems.length === 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex justify-end pt-2">
              <div className="w-64 space-y-2">
                <div className="flex justify-between text-sm"><span>Subtotal</span><span>{formatCurrency(itemsSubtotal, currency)}</span></div>
                <div className="flex justify-between text-sm"><span>Tax</span><span>{formatCurrency(itemsTax, currency)}</span></div>
                <div className="flex justify-between text-lg font-bold border-t pt-2"><span>Total</span><span>{formatCurrency(grandTotal, currency)}</span></div>
              </div>
            </div>
          </FieldGroup>

          <FieldGroup label="Additional Info">
            <FieldGrid columns={2}>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={3}
                  placeholder="Notes visible to customer..."
                />
              </div>
              <div className="space-y-2">
                <Label>Terms</Label>
                <Textarea
                  value={formData.terms}
                  onChange={(e) => setFormData({ ...formData, terms: e.target.value })}
                  rows={3}
                  placeholder="Terms and conditions..."
                />
              </div>
            </FieldGrid>
          </FieldGroup>
        </div>
      )}
    </RecordFormShell>
  );
}
