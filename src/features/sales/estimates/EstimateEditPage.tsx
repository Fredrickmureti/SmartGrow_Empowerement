/**
 * EstimateEditPage — `/sales/estimates/:id/edit`.
 *
 * Phase-3 route replacement for the retired `EditEstimateDialog`. Loads
 * the draft estimate from the URL param, hosts the form body on top of
 * `RecordFormShell`, and lands the user back on the estimate's object
 * page on save. Only draft estimates are editable; a non-draft :id
 * redirects to the object page with a toast.
 */
import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Estimate, EstimateItem } from "@/hooks/useEstimates";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
import { useSalesLineAvailability } from "@/features/sales/availability";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { computeLine } from "@/lib/invoiceLineMath";
import { computeEstimateTotals } from "@/lib/estimateLifecycle";
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
import { AdditionalCostsSection, AdditionalCost } from "@/components/common/AdditionalCostsSection";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { AITextAssist } from "@/components/shared/AITextAssist";
import { validateLineItems } from "@/lib/validation/lineItems";
import { normalizeError } from "@/services/resilience";
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
import { useUnitsForProducts } from "@/hooks/useSellableUnits";
import { useLinePriceResolver, useServerPriceApplier } from "@/hooks/useLinePriceResolver";

type LineItem = Omit<EstimateItem, "id" | "estimate_id"> & { id?: string };

export default function EstimateEditPage() {
  const navigate = useNavigate();
  const { id: estimateId } = useParams<{ id: string }>();

  const { contacts } = useContacts();
  // Branch-scoped so the edit surface reports the same server-resolved
  // availability the create surface does.
  const { products, branchScopeLabel } = useBranchScopedProducts();
  /** Sell units per product; the server re-derives the base quantity. */
  const unitsFor = useUnitsForProducts(products);
  const { toast } = useToast();

  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    contact_id: "",
    expiry_date: "",
    notes: "",
    terms: "",
    discount_amount: 0,
  });

  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  /** Advisory only — estimates never block on stock. */
  const availability = useSalesLineAvailability({
    kind: "estimate",
    lines: lineItems,
    products,
    scopeLabel: branchScopeLabel,
  });
  const [additionalCosts, setAdditionalCosts] = useState<AdditionalCost[]>([]);

  useEffect(() => {
    if (!estimateId) return;
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      try {
        const { data: est, error: estError } = await supabase
          .from("estimates")
          .select("*")
          .eq("id", estimateId)
          .maybeSingle();
        if (estError) throw estError;
        if (!est) {
          if (!cancelled) {
            toast({ title: "Estimate not found", variant: "destructive" });
            navigate("/sales/estimates");
          }
          return;
        }
        if (est.status !== "draft") {
          if (!cancelled) {
            toast({
              title: "Cannot edit",
              description: "Only draft estimates can be edited.",
              variant: "destructive",
            });
            navigate(`/sales/estimates/${est.id}`);
          }
          return;
        }

        const { data: items, error: itemsError } = await supabase
          .from("estimate_items")
          .select("*")
          .eq("estimate_id", est.id)
          .order("sort_order");
        if (itemsError) throw itemsError;

        const { data: costs, error: costsError } = await supabase
          .from("estimate_additional_costs")
          .select("*")
          .eq("estimate_id", est.id)
          .order("sort_order");
        if (costsError) throw costsError;

        if (cancelled) return;

        setEstimate(est as unknown as Estimate);
        setFormData({
          contact_id: est.contact_id || "",
          expiry_date: est.expiry_date,
          notes: est.notes || "",
          terms: est.terms || "",
          discount_amount: est.discount_amount || 0,
        });
        setLineItems(
          (items || []).map((item) => ({
            id: item.id,
            product_id: item.product_id,
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            tax_rate: item.tax_rate || 0,
            tax_amount: item.tax_amount || 0,
            discount_percent: item.discount_percent || 0,
            line_total: item.line_total,
            sort_order: item.sort_order || 0,
            packaging_id: item.packaging_id ?? null,
            display_quantity: item.display_quantity ?? null,
            display_uom_id: item.display_uom_id ?? null,
          })),
        );
        setAdditionalCosts(
          (costs || []).map((cost) => ({
            id: cost.id,
            name: cost.name,
            amount: cost.amount,
            is_taxable: cost.is_taxable || false,
            tax_rate: cost.tax_rate || 0,
            tax_amount: cost.tax_amount || 0,
            sort_order: cost.sort_order || 0,
          })),
        );
      } catch (error: any) {
        console.error("Error loading estimate:", error);
        if (!cancelled) {
          toast({
            title: "Failed to load estimate",
            description: normalizeError(error).message,
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [estimateId, navigate, toast]);

  const calculateLineTotal = (item: LineItem) => {
    // CONTRACT: line_total is tax-EXCLUSIVE — see src/lib/invoiceLineMath.ts.
    const { line_total, tax_amount } = computeLine({
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_percent: item.discount_percent,
      tax_rate: item.tax_rate,
    });
    return { line_total, tax_amount };
  };

  const updateLineItem = (index: number, updates: Partial<LineItem>) => {
    // Re-price whenever what the customer buys changes (unit or pack).
    if ((updates as Record<string, unknown>).packaging_id !== undefined || (updates as Record<string, unknown>).display_uom_id !== undefined) {
      void applyServerPrice(index, updates as never);
    }
    setLineItems((prev) => {
      const next = [...prev];
      const updatedItem = { ...next[index], ...updates };
      const calc = calculateLineTotal(updatedItem);
      next[index] = { ...updatedItem, ...calc };
      return next;
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
      {
        product_id: null,
        description: "",
        quantity: 1,
        unit_price: 0,
        tax_rate: 0,
        tax_amount: 0,
        discount_percent: 0,
        line_total: 0,
        sort_order: prev.length,
      },
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
    if (!estimate) return;

    setIsSubmitting(true);
    try {
      const result = validateLineItems(lineItems);
      if (!result.ok) throw new Error(result.error);
      const validItems = result.valid;

      // Canonical rollup: line_total is tax-EXCLUSIVE.
      let subtotal = 0;
      let taxAmount = 0;
      validItems.forEach((item) => {
        subtotal += item.line_total;
        taxAmount += item.tax_amount;
      });
      // One formula shared with the create path (see estimateLifecycle.ts).
      const totals = computeEstimateTotals(validItems, additionalCosts, formData.discount_amount);
      const additionalCostsTax = additionalCosts.reduce((sum, c) => sum + c.tax_amount, 0);
      const total = totals.total;

      // Phase 9: one governed server transaction owns the header, the lines
      // and the additional costs. Client totals above are preview only — the
      // server resolves base quantities and rewrites every total.
      await updateEstimateAtomic(
        estimate.id,
        {
          contact_id: formData.contact_id || null,
          expiry_date: formData.expiry_date,
          notes: formData.notes || null,
          terms: formData.terms || null,
          discount_amount: formData.discount_amount,
        },
        validItems.map((item, index) => ({
          product_id: item.product_id || null,
          description: item.description,
          quantity: item.quantity,
          display_quantity: (item as LineItem).display_quantity ?? null,
          display_uom_id: (item as LineItem).display_uom_id ?? null,
          packaging_id: (item as LineItem).packaging_id ?? null,
          unit_price: item.unit_price,
          discount_percent: item.discount_percent,
          tax_rate: item.tax_rate,
          sort_order: index,
        })),
        additionalCosts
          .filter((cost) => cost.name && cost.amount > 0)
          .map((cost, index) => ({
            name: cost.name,
            amount: cost.amount,
            is_taxable: cost.is_taxable,
            tax_rate: cost.tax_rate,
            sort_order: index,
          })),
      );


      toast({ title: "Estimate updated successfully" });
      navigate(`/sales/estimates/${estimate.id}`);
    } catch (error: any) {
      toast({
        title: "Error updating estimate",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      // architecture-allow: display-only fallback
      currency: estimate?.currency || "USD",
    }).format(amount);

  const itemsSubtotal = lineItems.reduce((sum, item) => sum + item.line_total, 0);
  const itemsTax = lineItems.reduce((sum, item) => sum + item.tax_amount, 0);
  const additionalCostsTotal = additionalCosts.reduce((sum, c) => sum + c.amount, 0);
  const additionalCostsTax = additionalCosts.reduce((sum, c) => sum + c.tax_amount, 0);
  const grandTotal =
    itemsSubtotal + itemsTax + additionalCostsTotal + additionalCostsTax - formData.discount_amount;

  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Estimate"
      recordRef={estimate?.estimate_number}
      meta="Only draft estimates can be edited."
      cancelHref={estimate?.id ? `/sales/estimates/${estimate.id}` : "/sales/estimates"}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Save changes"
    >
      <div className="space-y-6 min-w-0">
        <CustomFieldsSection
          entityType="estimate"
          entityId={estimate?.id || null}
          formValues={formData}
          disabled={isSubmitting}
          documentSection="header"
          showHeader={false}
        />

        <FieldGroup label="Customer & Dates">
          <FieldGrid columns={2}>
            <FieldCell>
              <div className="space-y-2">
                <Label htmlFor="customer">Customer</Label>
                <Select
                  value={formData.contact_id}
                  onValueChange={(value) => setFormData({ ...formData, contact_id: value })}
                >
                  <SelectTrigger id="customer">
                    <SelectValue placeholder="Select customer" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </FieldCell>
            <FieldCell>
              <div className="space-y-2">
                <Label htmlFor="expiry_date">Expiry Date *</Label>
                <Input
                  id="expiry_date"
                  type="date"
                  value={formData.expiry_date}
                  onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                  required
                />
              </div>
            </FieldCell>
          </FieldGrid>
        </FieldGroup>

        <CustomFieldsSection
          entityType="estimate"
          entityId={estimate?.id || null}
          formValues={formData}
          disabled={isSubmitting}
          documentSection="details"
          showHeader={false}
        />

        <FieldGroup label="Line Items">
          <EditableLineItemsGrid
            columns={PRICED_LINE_COLUMNS}
            rows={lineItems}
            toolbar={
              <DocumentLineScanner
                documentLabel="Estimate"
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
                formatCurrency={formatCurrency}
                onPatch={updateLineItem}
                onProductSelect={handleProductSelect}
                stockEval={availability.evals[index] ?? null}
              />
            )}
          />
        </FieldGroup>

        <AdditionalCostsSection
          costs={additionalCosts}
          onChange={setAdditionalCosts}
          formatCurrency={formatCurrency}
        />

        <div className="flex justify-end">
          <div className="w-full sm:w-64 space-y-2">
            <div className="flex justify-between text-sm">
              <span>Subtotal</span>
              <span>{formatCurrency(itemsSubtotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>Tax</span>
              <span>{formatCurrency(itemsTax + additionalCostsTax)}</span>
            </div>
            {additionalCostsTotal > 0 && (
              <div className="flex justify-between text-sm">
                <span>Additional Costs</span>
                <span>{formatCurrency(additionalCostsTotal)}</span>
              </div>
            )}
            <div className="flex justify-between items-center text-sm">
              <span>Discount</span>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={formData.discount_amount}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    discount_amount: parseFloat(e.target.value) || 0,
                  })
                }
                className="h-8 w-24 text-right"
              />
            </div>
            <div className="flex justify-between text-lg font-bold border-t pt-2">
              <span>Total</span>
              <span>{formatCurrency(grandTotal)}</span>
            </div>
          </div>
        </div>

        <CustomFieldsSection
          entityType="estimate"
          entityId={estimate?.id || null}
          formValues={formData}
          disabled={isSubmitting}
          documentSection="after_items"
          showHeader={false}
        />

        <FieldGroup label="Notes & Terms">
          <FieldGrid columns={2}>
            <FieldCell>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="notes">Notes</Label>
                  <AITextAssist
                    fieldType="notes"
                    documentType="estimate"
                    currentValue={formData.notes}
                    onApply={(text) => setFormData({ ...formData, notes: text })}
                    customerName={customers.find((c) => c.id === formData.contact_id)?.name}
                    documentNumber={estimate?.estimate_number}
                    totalAmount={grandTotal}
                    currency={estimate?.currency}
                  />
                </div>
                <Textarea
                  id="notes"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={3}
                  placeholder="Notes visible to customer..."
                />
              </div>
            </FieldCell>
            <FieldCell>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="terms">Terms</Label>
                  <AITextAssist
                    fieldType="terms"
                    documentType="estimate"
                    currentValue={formData.terms}
                    onApply={(text) => setFormData({ ...formData, terms: text })}
                    customerName={customers.find((c) => c.id === formData.contact_id)?.name}
                    documentNumber={estimate?.estimate_number}
                    totalAmount={grandTotal}
                    currency={estimate?.currency}
                  />
                </div>
                <Textarea
                  id="terms"
                  value={formData.terms}
                  onChange={(e) => setFormData({ ...formData, terms: e.target.value })}
                  rows={3}
                  placeholder="Terms and conditions..."
                />
              </div>
            </FieldCell>
          </FieldGrid>
        </FieldGroup>

        <CustomFieldsSection
          entityType="estimate"
          entityId={estimate?.id || null}
          formValues={formData}
          disabled={isSubmitting}
          documentSection="notes"
          showHeader={false}
        />

        <CustomFieldsSection
          entityType="estimate"
          entityId={estimate?.id || null}
          formValues={formData}
          disabled={isSubmitting}
          documentSection={["footer", "additional"]}
        />
      </div>
    </RecordFormShell>
  );
}
