/**
 * SalesOrderEditPage — `/sales/orders/:id/edit`.
 *
 * Phase-3 route replacement for the retired `EditSalesOrderDialog`.
 * Only draft sales orders can be edited (RLS + business rule).
 */
import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
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
import { Loader2 } from "lucide-react";
import { validateLineItems } from "@/lib/validation/lineItems";
import {
  OversellConfirmation,
  useSalesLineAvailability,
} from "@/features/sales/availability";
import { ShipToPicker } from "@/components/addresses/ShipToPicker";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { LineAnalyticsCell } from "@/components/projects/LineAnalyticsCell";
import { CapabilityGate } from "@/components/apps/CapabilityGate";
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { PricedLineRow, PRICED_LINE_COLUMNS } from "@/components/documents/lines/PricedLineRow";
import { computeLine } from "@/lib/invoiceLineMath";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { DocumentLineScanner } from "@/components/documents/lines/DocumentLineScanner";
import {
  usePricedLineScan,
  scanUnitPrice,
  scanTaxRate,
} from "@/features/sales/scan-session/useDocumentLineScan";
import { normalizeError } from "@/services/resilience";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { useUnitsForProducts } from "@/hooks/useSellableUnits";
import { useLinePriceResolver, useServerPriceApplier } from "@/hooks/useLinePriceResolver";

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
  ship_to_contact_id: string | null;
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
  // Branch-scoped catalogue: the edit surface must see the SAME server-resolved
  // availability the create surface does, or the two disagree about whether an
  // order can be fulfilled.
  const { products, branchScopeLabel } = useBranchScopedProducts();
  /** Sell units per product; the server re-derives the base quantity. */
  const unitsFor = useUnitsForProducts(products);
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [order, setOrder] = useState<OrderData | null>(null);

  const [formData, setFormData] = useState({
    contact_id: "",
    order_date: "",
    expected_date: "",
    ship_to_contact_id: null as string | null,
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
      const row = data as any;
      setOrder(row as OrderData);

      setFormData({
        contact_id: row.contact_id || "",
        order_date: row.order_date || "",
        expected_date: row.expected_date || "",
        ship_to_contact_id: row.ship_to_contact_id ?? null,
        shipping_address: row.shipping_address || "",
        notes: row.notes || "",
        terms: row.terms || "",
        project_id: row.project_id ?? null,
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
    // Re-price whenever what the customer buys changes (unit or pack).
    if ((updates as Record<string, unknown>).packaging_id !== undefined || (updates as Record<string, unknown>).display_uom_id !== undefined) {
      void applyServerPrice(index, updates as never);
    }
    setLineItems((prev) => {
      const newItems = [...prev];
      const updatedItem = { ...newItems[index], ...updates };
      const calculated = calculateLineTotal(updatedItem);
      newItems[index] = { ...updatedItem, ...calculated };
      return newItems;
    });
  };

  // Scan-to-line parity — same workspace scanner as every other Sales document.
  const { currentBusiness } = useBusinesses();

  /** Server-authoritative price for a line, previewed in the editor. */
  const resolvePrice = useLinePriceResolver(currentBusiness?.id, formData.contact_id || null);
  const applyServerPrice = useServerPriceApplier(lineItems, setLineItems, resolvePrice);
  const { currentBranch } = useBranches();
  const { handleScanResolved, handleScanSessionCommit, flashIndex } = usePricedLineScan(
    setLineItems,
    (resolved, quantity, lines) => {
      const seed = {
        product_id: resolved.productId,
        description: resolved.name,
        quantity,
        unit_price: scanUnitPrice(resolved),
        tax_rate: scanTaxRate(resolved),
        discount_percent: 0,
        sort_order: lines.length,
      };
      const { line_total, tax_amount } = computeLine(seed);
      return { ...seed, line_total, tax_amount };
    },
  );

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
    // Product scalar is an optimistic placeholder; the server resolver
    // (price list > price book > product) is the authority and is what the
    // database stamps on insert.
    void applyServerPrice(index, { product_id: productId });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderId || !order) return;

    setIsSubmitting(true);
    try {
      const result = validateLineItems(lineItems);
      if (!result.ok) throw new Error(result.error);
      const validItems = result.valid;

      // Phase 5.5: the edit is DB-owned. `update_sales_order_atomic` updates
      // surviving lines in place (preserving quantity_fulfilled /
      // quantity_invoiced and the invoice/delivery provenance links), refuses
      // to remove or under-run lines that already moved, and recomputes
      // totals server-side. Never delete-and-reinsert lines from the client.
      const { data: authData } = await supabase.auth.getUser();

      const { data: rpcData, error: rpcError } = await supabase.rpc(
        "update_sales_order_atomic" as any,
        {
          p_so_id: orderId,
          p_user_id: authData?.user?.id ?? null,
          p_header: {
            contact_id: formData.contact_id || null,
            order_date: formData.order_date,
            expected_date: formData.expected_date || null,
            ship_to_contact_id: formData.ship_to_contact_id,
            shipping_address: formData.shipping_address || null,
            notes: formData.notes || null,
            terms: formData.terms || null,
            project_id: formData.project_id,
          },
          p_items: validItems.map((item, index) => ({
            id: (item as LineItem).id ?? null,
            product_id: item.product_id || null,
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            tax_rate: item.tax_rate,
            tax_amount: item.tax_amount,
            line_total: item.line_total,
            sort_order: index,
            project_id: (item as LineItem).project_id ?? null,
            packaging_id: (item as LineItem).packaging_id ?? null,
            display_quantity: (item as LineItem).display_quantity ?? null,
            display_uom_id: (item as LineItem).display_uom_id ?? null,
          })),
        },
      );

      if (rpcError) throw rpcError;
      const rpcResult = rpcData as unknown as { success?: boolean; error?: string } | null;
      if (!rpcResult?.success) throw new Error(rpcResult?.error || "Failed to update sales order");

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
  const formatLineCurrency = useCallback(
    (n: number) => formatCurrency(n, currency),
    [formatCurrency, currency],
  );

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Sales Order"
      recordRef={order?.so_number}
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
              <div className="space-y-2 md:col-span-2">
                <ShipToPicker
                  contactId={formData.contact_id || null}
                  preserveExisting
                  value={{
                    shipToContactId: formData.ship_to_contact_id,
                    shippingAddress: formData.shipping_address,
                  }}
                  onChange={(next) =>
                    setFormData((prev) => ({
                      ...prev,
                      ship_to_contact_id: next.shipToContactId,
                      shipping_address: next.shippingAddress,
                    }))
                  }
                />
              </div>
            </FieldGrid>
          </FieldGroup>

          <CapabilityGate cap="projects.analytic-tagging">
            <FieldGroup label="Shipping & Project">
              <ProjectPicker
                enabled={true}
                value={formData.project_id}
                onChange={(id) => setFormData({ ...formData, project_id: id })}
                customerId={formData.contact_id || null}
                helperText="Optional — links the SO and its eventual invoice to project profitability."
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
                />
              }
              disabled={isSubmitting}
              addLabel="Add Item"
              onAddRow={addLineItem}
              onRemoveRow={removeLineItem}
              renderRow={(item, index, layout) => (
                <PricedLineRow
                  unitsFor={unitsFor}
                  index={index}
                  item={item}
                  flashed={flashIndex === index}
                  products={products}
                  layout={layout}
                  disabled={isSubmitting}
                  formatCurrency={formatLineCurrency}
                  onPatch={updateLineItem}
                  onProductSelect={handleProductSelect}
                  extra={
                    <LineAnalyticsCell
                      projectId={item.project_id ?? null}
                      taskId={item.task_id ?? null}
                      headerProjectId={formData.project_id}
                      customerId={formData.contact_id || null}
                      onChange={(next) => updateLineItem(index, next)}
                      disabled={isSubmitting}
                    />
                  }
                />
              )}
            />

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
