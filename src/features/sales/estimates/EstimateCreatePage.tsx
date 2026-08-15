/**
 * EstimateCreatePage — `/sales/estimates/new`.
 *
 * Phase-3 route replacement for the retired `CreateEstimateDialog`.
 * Hosts the same form body on top of `RecordFormShell` so the create
 * flow uses the platform-standard sticky header + footer instead of a
 * DetailSheet overlay. Deep-link params supported:
 *   ?contact_id=<uuid>   pre-fill customer
 *
 * Line math is aligned with the invoice contract: `line_total` is
 * tax-EXCLUSIVE — see `src/lib/invoiceLineMath.ts` and the guard test
 * `src/test/architecture/invoice-totals-contract.test.ts`.
 */
import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useEstimates, EstimateItem } from "@/hooks/useEstimates";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import { computeLine, computeTotals } from "@/lib/invoiceLineMath";
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
import { AdditionalCostsSection, AdditionalCost } from "@/components/common/AdditionalCostsSection";
import { validateLineItems } from "@/lib/validation/lineItems";
import { AITextAssist } from "@/components/shared/AITextAssist";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
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

export default function EstimateCreatePage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Handheld list pages deep-link here with `openScanSession` so the
  // camera sheet opens immediately (see ScanToDocumentButton).
  const openScanSessionOnMount =
    ((location.state as { openScanSession?: boolean } | null)?.openScanSession) === true;
  const [searchParams] = useSearchParams();
  const prefillContactId = searchParams.get("contact_id") ?? "";

  const { getNextEstimateNumber, createEstimate } = useEstimates();
  const { contacts } = useContacts();
  const { products, branchScopeLabel } = useBranchScopedProducts();
  /** Sell units per product; the server re-derives the base quantity. */
  const unitsFor = useUnitsForProducts(products);
  const { formatCurrency, baseCurrency } = useCurrency();
  const { toast } = useToast();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    contact_id: prefillContactId,
    expiry_date: "",
    notes: "",
    terms: "",
    discount_amount: 0,
  });

  const [lineItems, setLineItems] = useState<Omit<EstimateItem, "id" | "estimate_id">[]>([
    { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0, tax_amount: 0, discount_percent: 0, line_total: 0, sort_order: 0 },
  ]);

  const [additionalCosts, setAdditionalCosts] = useState<AdditionalCost[]>([]);

  const customers = contacts.filter((c) => (c.type === "customer" || c.type === "both") && c.is_active);

  useEffect(() => {
    if (prefillContactId) {
      setFormData((prev) => ({ ...prev, contact_id: prefillContactId }));
    }
  }, [prefillContactId]);

  const calculateLineTotal = (item: typeof lineItems[0]) => {
    // CONTRACT: line_total is tax-EXCLUSIVE — see src/lib/invoiceLineMath.ts.
    const { line_total, tax_amount } = computeLine({
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_percent: item.discount_percent,
      tax_rate: item.tax_rate,
    });
    return { line_total, tax_amount };
  };

  const applyLinePatch = (index: number, patch: Record<string, any>) => {
    const updated = [...lineItems];
    updated[index] = { ...updated[index], ...patch };

    if ("product_id" in patch && patch.product_id) {
      const product = products.find((p) => p.id === patch.product_id);
      if (product) {
        updated[index].description = product.name;
        updated[index].unit_price = product.unit_price;
        updated[index].tax_rate = product.tax_rate || 0;
      }
    }

    const calc = calculateLineTotal(updated[index]);
    updated[index].line_total = calc.line_total;
    updated[index].tax_amount = calc.tax_amount;
    setLineItems(updated);
  };

  const formatLineCurrency = useCallback(
    (amount: number) => formatCurrency(amount, baseCurrency),
    [formatCurrency, baseCurrency],
  );

  // Scan-to-line parity — the Sales workspace scan transport is live on every
  // page (SalesLayout mounts SalesScanProvider); this form is a consumer of it.
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
    setLineItems([
      ...lineItems,
      { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0, tax_amount: 0, discount_percent: 0, line_total: 0, sort_order: lineItems.length },
    ]);
  };

  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) {
      setLineItems(lineItems.filter((_, i) => i !== index));
    }
  };

  const handleCustomerChange = async (v: string) => {
    setFormData({ ...formData, contact_id: v });
    try {
      const defaults = await fetchContactDefaults(v);
      if (defaults.tax_exemption_number) {
        setLineItems((prev) =>
          prev.map((item) => {
            const updated = { ...item, tax_rate: 0 };
            const calc = calculateLineTotal(updated);
            return { ...updated, line_total: calc.line_total, tax_amount: calc.tax_amount };
          }),
        );
      } else if (defaults.default_tax_rate_id) {
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
              return { ...updated, line_total: calc.line_total, tax_amount: calc.tax_amount };
            }),
          );
        }
      }
    } catch (e) {
      console.error("Failed to fetch contact defaults:", e);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.contact_id) {
      toast({ title: "Please select a customer", variant: "destructive" });
      return;
    }
    const result = validateLineItems(lineItems);
    if (!result.ok) {
      toast({ title: "Cannot create estimate", description: result.error, variant: "destructive" });
      return;
    }
    const validItems = result.valid;

    setIsSubmitting(true);
    try {
      const estimateNumber = await getNextEstimateNumber();
      const created = await createEstimate(
        {
          estimate_number: estimateNumber,
          contact_id: formData.contact_id,
          status: "draft",
          issue_date: new Date().toISOString().split("T")[0],
          expiry_date: formData.expiry_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
          subtotal: 0,
          tax_amount: 0,
          discount_amount: formData.discount_amount,
          total: 0,
          currency: baseCurrency,
          notes: formData.notes || null,
          terms: formData.terms || null,
          converted_invoice_id: null,
          converted_at: null,
          customer_signature_url: null,
          signed_at: null,
          signed_by_name: null,
          signed_by_email: null,
        },
        validItems,
        additionalCosts.filter((cost) => cost.name && cost.amount > 0),
      );
      toast({ title: "Estimate created successfully" });
      navigate(created?.id ? `/sales/estimates/${created.id}` : "/sales/estimates");
    } catch (error: any) {
      toast({ title: "Error creating estimate", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  // line_total is tax-exclusive — use canonical computeTotals for the header rollup.
  const { subtotal, tax_total: itemsTax, total: itemsGrandBase } = computeTotals(
    lineItems,
    formData.discount_amount,
  );
  const additionalCostsTotal = additionalCosts.reduce((sum, cost) => sum + cost.amount, 0);
  const additionalCostsTax = additionalCosts.reduce((sum, cost) => sum + cost.tax_amount, 0);
  const grandTotal = itemsGrandBase + additionalCostsTotal + additionalCostsTax;

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Estimate"
      meta={
        <>
          Create a new quote for your customer · Stock shown for:{" "}
          <span className="font-medium text-foreground">{branchScopeLabel}</span>
        </>
      }
      cancelHref="/sales/estimates"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!formData.contact_id}
      submitLabel="Create Estimate"
    >
      <div className="space-y-6 min-w-0">
        <FieldGroup label="Customer & Dates">
          <FieldGrid columns={2}>
            <FieldCell>
              <div className="space-y-2">
                <Label>
                  Customer <span className="text-destructive" aria-hidden="true">*</span>
                </Label>
                <Select value={formData.contact_id} onValueChange={handleCustomerChange}>
                  <SelectTrigger
                    aria-required="true"
                    aria-invalid={!formData.contact_id}
                    className={!formData.contact_id ? "border-destructive focus:ring-destructive" : undefined}
                  >
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
                <Label>Expiry Date</Label>
                <Input
                  type="date"
                  value={formData.expiry_date}
                  onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                />
              </div>
            </FieldCell>
          </FieldGrid>
        </FieldGroup>

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
                openSessionOnMount={openScanSessionOnMount}
              />
            }
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
                formatCurrency={formatLineCurrency}
                onPatch={applyLinePatch}
                productPlaceholder="Product (optional)"
              />
            )}
          />
        </FieldGroup>

        <AdditionalCostsSection
          costs={additionalCosts}
          onChange={setAdditionalCosts}
          formatCurrency={(amount) => formatCurrency(amount, baseCurrency)}
        />

        <div className="flex justify-end">
          <div className="w-full sm:w-64 space-y-2 text-sm">
            <div className="flex justify-between"><span>Subtotal:</span><span>{formatCurrency(subtotal, baseCurrency)}</span></div>
            <div className="flex justify-between"><span>Tax:</span><span>{formatCurrency(itemsTax + additionalCostsTax, baseCurrency)}</span></div>
            {additionalCostsTotal > 0 && (
              <div className="flex justify-between"><span>Additional Costs:</span><span>{formatCurrency(additionalCostsTotal, baseCurrency)}</span></div>
            )}
            <div className="flex justify-between items-center">
              <span>Discount:</span>
              <Input
                type="number"
                className="w-24 h-8"
                value={formData.discount_amount}
                onChange={(e) => setFormData({ ...formData, discount_amount: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div className="flex justify-between font-bold text-lg border-t pt-2">
              <span>Total:</span><span>{formatCurrency(grandTotal, baseCurrency)}</span>
            </div>
          </div>
        </div>

        <FieldGroup label="Notes & Terms">
          <FieldGrid columns={2}>
            <FieldCell>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Notes</Label>
                  <AITextAssist
                    fieldType="notes"
                    documentType="estimate"
                    currentValue={formData.notes}
                    onApply={(text) => setFormData({ ...formData, notes: text })}
                    customerName={customers.find((c) => c.id === formData.contact_id)?.name}
                    totalAmount={grandTotal}
                    currency={baseCurrency}
                  />
                </div>
                <Textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Notes for the customer..."
                />
              </div>
            </FieldCell>
            <FieldCell>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Terms & Conditions</Label>
                  <AITextAssist
                    fieldType="terms"
                    documentType="estimate"
                    currentValue={formData.terms}
                    onApply={(text) => setFormData({ ...formData, terms: text })}
                    customerName={customers.find((c) => c.id === formData.contact_id)?.name}
                    totalAmount={grandTotal}
                    currency={baseCurrency}
                  />
                </div>
                <Textarea
                  value={formData.terms}
                  onChange={(e) => setFormData({ ...formData, terms: e.target.value })}
                  placeholder="Terms and conditions..."
                />
              </div>
            </FieldCell>
          </FieldGrid>
        </FieldGroup>

        <CustomFieldsSection
          entityType="estimate"
          entityId={null}
          formValues={formData}
          disabled={isSubmitting}
        />
      </div>
    </RecordFormShell>
  );
}
