/**
 * InvoiceCreatePage — `/sales/invoices/new`.
 *
 * Phase-3 route replacement for the retired `CreateInvoiceDialog`.
 * Hosts the identical form body on top of `RecordFormShell` so the
 * page uses the platform-standard sticky header + footer instead of a
 * DetailSheet overlay. Deep-link params supported:
 *   ?contact_id=<uuid>   pre-fill customer
 *   ?project_id=<uuid>   pre-fill project
 *
 * Line-item math is unchanged (`computeLine` / `computeTotals`) — see
 * `src/test/architecture/invoice-totals-contract.test.ts` for the
 * tax-exclusive contract guard.
 */
import { normalizeError } from "@/services/resilience";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { InvoiceLineRow, INVOICE_LINE_COLUMNS } from "@/components/invoices/InvoiceLineRow";
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { InvoiceItem, useInvoicesPaginated } from "@/hooks/useInvoicesPaginated";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useCurrency } from "@/hooks/useCurrency";
import { usePaymentTerms } from "@/hooks/usePaymentTerms";
import { useCustomerCredit } from "@/hooks/useCustomerCredit";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import {
  resolvePaymentTerm,
  dueDateFromTerm,
  todayIso,
} from "@/services/finance/paymentTerms";
import { computeLine, computeTotals } from "@/lib/invoiceLineMath";
import { CreditCheckAlert } from "@/components/shared/CreditCheckAlert";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { AITextAssist } from "@/components/shared/AITextAssist";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { format, addDays } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  evaluateStock,
} from "@/components/inventory/StockAvailabilityIndicator";
import { validateLineItems } from "@/lib/validation/lineItems";
import {
  OversellConfirmation,
  useSalesLineAvailability,
} from "@/features/sales/availability";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { CapabilityGate } from "@/components/apps/CapabilityGate";
import { DocumentLineScanner } from "@/components/documents/lines/DocumentLineScanner";
import {
  usePricedLineScan,
  scanUnitPrice,
  scanTaxRate,
} from "@/features/sales/scan-session/useDocumentLineScan";
import type { ResolvedScan } from "@/hooks/scanner";
import { cn } from "@/lib/utils";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { useUnitsForProducts } from "@/hooks/useSellableUnits";
import { useLinePriceResolver, useServerPriceApplier } from "@/hooks/useLinePriceResolver";

export default function InvoiceCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const prefillContactId = searchParams.get("contact_id") ?? undefined;
  const defaultProjectId = searchParams.get("project_id");
  const initialScan =
    ((location.state as { initialScan?: ResolvedScan } | null)?.initialScan) ?? null;
  const openScanSessionOnMount =
    ((location.state as { openScanSession?: boolean } | null)?.openScanSession) === true;

  const { contacts } = useContacts();
  const customers = useMemo(
    () =>
      contacts
        .filter((c) => c.type === "customer" || c.type === "both")
        .map((c) => ({ id: c.id, name: c.name, email: c.email })),
    [contacts],
  );
  const { createInvoice } = useInvoicesPaginated({});

  const defaultCustomerId: string | null = null;
  const onCleanupParams: undefined = undefined;
  // `open` used by legacy effects below; route pages are always "open".
  const open = true;

  const onSubmit = createInvoice;
  const onOpenChange = (_next: boolean) => {
    // Route pages replace open/close with navigation. Called only on
    // success (post-toast) to leave the /new route.
  };


  const { products, branchScopeLabel } = useBranchScopedProducts();


  /** Sell units per product; the server re-derives the base quantity. */


  const unitsFor = useUnitsForProducts(products);
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { formatCurrency, baseCurrency } = useCurrency();
  const { paymentTerms } = usePaymentTerms();
  const { user } = useAuth();
  const { members } = useOrgMembers();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmOversell, setConfirmOversell] = useState(false);

  const [formData, setFormData] = useState({
    contact_id: "",
    // Due date is derived from the resolved payment term (see the effect
    // below). Seeded to the issue date = due on receipt, never an invented
    // 30-day term.
    due_date: todayIso(),
    notes: "",
    // Free-text terms & conditions ONLY. The structured payment term lives in
    // `payment_term_id`; never stamp a term name into this field.
    terms: "",
    discount_amount: 0,
    currency: "",
    markAsSent: false,
    salesperson_id: "",
    project_id: null as string | null,
    payment_term_id: null as string | null,
  });

  const [lineItems, setLineItems] = useState<Omit<InvoiceItem, "id" | "invoice_id">[]>([
    { description: "", quantity: 1, unit_price: 0, tax_rate: 0, tax_amount: 0, discount_percent: 0, line_total: 0, sort_order: 0 },
  ]);

  /** Server-authoritative price for a line, previewed in the editor. */
  const resolvePrice = useLinePriceResolver(currentBusiness?.id, formData.contact_id || null);
  const applyServerPrice = useServerPriceApplier(lineItems, setLineItems, resolvePrice);

  const linesTableRef = useRef<HTMLDivElement | null>(null);
  const initialScanKeyRef = useRef<string | null>(null);

  // Available credit notes for selected customer
  const [availableCredit, setAvailableCredit] = useState(0);

  useEffect(() => {
    if (open) {
      const cid = prefillContactId ?? defaultCustomerId ?? "";
      setFormData((prev) => ({
        ...prev,
        contact_id: cid || prev.contact_id,
        project_id: defaultProjectId ?? prev.project_id,
      }));
    }
  }, [prefillContactId, defaultCustomerId, defaultProjectId, open]);

  // Seed the due date from the company's configured default term whenever the
  // form opens without a customer yet. Server-side resolver only — the UI must
  // never guess a credit period.
  useEffect(() => {
    if (!open || !currentBusiness?.organization_id) return;
    let cancelled = false;
    (async () => {
      try {
        const resolved = await resolvePaymentTerm({
          organizationId: currentBusiness.organization_id,
          businessId: currentBusiness.id,
        });
        if (cancelled) return;
        setFormData((prev) =>
          prev.contact_id
            ? prev
            : {
                ...prev,
                payment_term_id: resolved?.payment_term_id ?? null,
                due_date: dueDateFromTerm(todayIso(), resolved?.days ?? 0),
              },
        );
      } catch {
        // Leave the due-on-receipt seed in place.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, currentBusiness?.id, currentBusiness?.organization_id]);

  // Fetch available credit notes when customer changes
  useEffect(() => {
    if (!formData.contact_id) {
      setAvailableCredit(0);
      return;
    }
    const fetchCredit = async () => {
      const { data } = await supabase
        .from("credit_notes")
        .select("total, amount_applied")
        .eq("contact_id", formData.contact_id)
        .eq("status", "issued");
      const total = (data || []).reduce((sum, cn) => sum + ((cn.total || 0) - (cn.amount_applied || 0)), 0);
      setAvailableCredit(total);
    };
    fetchCredit();
  }, [formData.contact_id]);

  const { creditInfo, checkCreditAvailability } = useCustomerCredit(formData.contact_id || undefined);

  const resetForm = () => {
    setFormData({
      contact_id: "",
      due_date: todayIso(),
      notes: "",
      terms: "",
      discount_amount: 0,
      currency: baseCurrency,
      markAsSent: false,
      salesperson_id: user?.id || "",
      project_id: null,
      payment_term_id: null,
    });
    setLineItems([
      { description: "", quantity: 1, unit_price: 0, tax_rate: 0, tax_amount: 0, discount_percent: 0, line_total: 0, sort_order: 0 },
    ]);
    setAvailableCredit(0);
  };

  const calculateLineTotal = (item: typeof lineItems[0]) => {
    // CONTRACT: line_total is tax-EXCLUSIVE (Odoo / `confirm_invoice_atomic` validator).
    // See src/lib/invoiceLineMath.ts for the canonical rule and rationale.
    const { line_total, tax_amount } = computeLine({
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_percent: item.discount_percent,
      tax_rate: item.tax_rate,
    });
    return { line_total, tax_amount };
  };

  const updateLineItem = useCallback((index: number, updates: Partial<typeof lineItems[0]>) => {
    // Re-price whenever what the customer buys changes (unit or pack).
    if ((updates as Record<string, unknown>).packaging_id !== undefined || (updates as Record<string, unknown>).display_uom_id !== undefined) {
      void applyServerPrice(index, updates as never);
    }
    setLineItems((prev) => {
      const newItems = [...prev];
      const updatedItem = { ...newItems[index], ...updates };
      const { line_total, tax_amount } = computeLine({
        quantity: updatedItem.quantity,
        unit_price: updatedItem.unit_price,
        discount_percent: updatedItem.discount_percent,
        tax_rate: updatedItem.tax_rate,
      });
      newItems[index] = { ...updatedItem, line_total, tax_amount };
      return newItems;
    });
  }, [applyServerPrice]);

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [
      ...prev,
      { description: "", quantity: 1, unit_price: 0, tax_rate: 0, tax_amount: 0, discount_percent: 0, line_total: 0, sort_order: prev.length },
    ]);
  }, []);

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }, []);

  const handleProductSelect = useCallback((index: number, productId: string) => {
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
  }, [products, updateLineItem, applyServerPrice]);

  /**
   * Scan-first line entry — `doc_author` semantics, now shared with every
   * other Sales document through `usePricedLineScan`. A scan for a product
   * already on the draft flashes that line instead of silently bumping its
   * quantity; a reviewed Scan Session batch is authoritative.
   */
  const { handleScanResolved, handleScanSessionCommit, flashIndex, handleScanResolvedRef } =
    usePricedLineScan(setLineItems, (resolved, quantity, lines) => {
      const seed = {
        product_id: resolved.productId,
        description: resolved.name,
        quantity,
        unit_price: scanUnitPrice(resolved),
        tax_rate: scanTaxRate(resolved),
        discount_percent: 0,
        sort_order: lines.length,
      };
      const { line_total, tax_amount } = calculateLineTotal(seed as never);
      return { ...seed, line_total, tax_amount };
    });

  useEffect(() => {
    if (!open) {
      initialScanKeyRef.current = null;
      return;
    }
    if (!initialScan) return;
    const key = `${initialScan.productId}:${initialScan.matchedCode}:${initialScan.scanQuantity}`;
    if (initialScanKeyRef.current === key) return;
    initialScanKeyRef.current = key;
    handleScanResolvedRef.current(initialScan);
  }, [open, initialScan]);

  const handleCustomerChange = async (value: string) => {
    setFormData((prev) => ({ ...prev, contact_id: value }));
    try {
      const defaults = await fetchContactDefaults(value);
      // Payment term: customer default, else company default, else due on
      // receipt. Resolved server-side so every document path agrees. The term
      // NAME is deliberately not written into `terms` — that field is the
      // invoice's terms & conditions prose, a different concept.
      const resolved = await resolvePaymentTerm({
        organizationId: currentBusiness?.organization_id,
        businessId: currentBusiness?.id,
        contactId: value,
      });
      setFormData((prev) => ({
        ...prev,
        payment_term_id: resolved?.payment_term_id ?? null,
        due_date: dueDateFromTerm(todayIso(), resolved?.days ?? 0),
      }));
      if (defaults.tax_exemption_number) {
        setLineItems((prev) =>
          prev.map((item) => {
            const updated = { ...item, tax_rate: 0 };
            return { ...updated, ...calculateLineTotal(updated) };
          })
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
              return { ...updated, ...calculateLineTotal(updated) };
            })
          );
        }
      }
    } catch (e) {
      console.error("Failed to fetch contact defaults:", e);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      if (!formData.contact_id) throw new Error("Please select a customer for this invoice");
      const result = validateLineItems(lineItems);
      if (!result.ok) {
        throw new Error(result.error);
      }
      const validItems = result.valid;

      // Block oversell unless explicitly confirmed. The guard, the line badges
      // and the confirmation list all read the SAME evaluation, so what the
      // operator sees is exactly what we validate against.
      availability.assertSellable();

      if (formData.contact_id && creditInfo) {
        const totalAmount = validItems.reduce((sum, item) => {
          const lineTotal = item.quantity * item.unit_price;
          const tax = lineTotal * ((item.tax_rate || 0) / 100);
          return sum + lineTotal + tax;
        }, 0);
        const creditResult = checkCreditAvailability(totalAmount);
        if (!creditResult.allowed) throw new Error(creditResult.reason || "Credit check failed");
      }
      const created = await onSubmit(
        {
          contact_id: formData.contact_id || undefined,
          due_date: formData.due_date,
          notes: formData.notes || undefined,
          terms: formData.terms || undefined,
          discount_amount: formData.discount_amount,
          currency: formData.currency || baseCurrency,
          status: formData.markAsSent ? "sent" : "draft",
          salesperson_id: formData.salesperson_id || undefined,
          project_id: formData.project_id,
        },
        validItems
      );
      toast({ title: "Invoice created as draft", description: "Confirm the invoice to post it to the General Ledger." });
      // Land on the new invoice's object page so the operator can confirm / send / print.
      navigate(created?.id ? `/sales/invoices/${created.id}` : "/sales/invoices");
    } catch (error: any) {
      toast({ title: "Error creating invoice", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  // line_total is tax-exclusive, so subtotal = SUM(line_total) directly.
  const { subtotal, tax_total: taxTotal, total: grandTotal } = computeTotals(
    lineItems,
    formData.discount_amount,
  );

  // Stock evaluation per line — drives badges, inline messages, and the
  // oversell submit guard. Shared with every other Sales editor via the
  // `commit` policy in `@/features/sales/availability`; untracked / service
  // products are ignored, and `available` is the branch-scoped figure the
  // server resolved.
  const lineStockEvals = availability.evals;

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Invoice"
      meta={
        <>
          Fill in the details to create a new invoice · Stock shown for:{" "}
          <span className="font-medium text-foreground">{branchScopeLabel}</span>
        </>
      }
      cancelHref="/sales/invoices"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={!formData.contact_id}
      submitLabel={formData.markAsSent ? "Create & Send" : "Create as Draft"}
    >
      <div className="space-y-6 min-w-0">

        <CreditCheckAlert
          customerId={formData.contact_id || undefined}
          orderAmount={lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price * (1 + (item.tax_rate || 0) / 100), 0)}
        />

        {/* Available Credit Alert */}
        {availableCredit > 0 && (
          <Alert className="border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30">
            <AlertCircle className="h-4 w-4 text-blue-600" />
            <AlertDescription className="text-blue-800 dark:text-blue-300">
              This customer has <strong>{formatCurrency(availableCredit)}</strong> in available credit notes.
              <Badge variant="outline" className="ml-2 text-[10px]">Can be applied after creation</Badge>
            </AlertDescription>
          </Alert>
        )}

        {/* Customer & Dates */}
        <FieldGroup label="Customer & Dates">
          <FieldGrid columns={3}>
            <div className="space-y-2">
              <Label htmlFor="customer">
                Customer <span className="text-destructive" aria-hidden="true">*</span>
              </Label>
              <Select value={formData.contact_id} onValueChange={handleCustomerChange}>
                <SelectTrigger
                  id="customer"
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
              {!formData.contact_id && (
                <p className="text-xs text-destructive" role="alert">
                  A customer is required to create an invoice.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="due_date">Due Date *</Label>
              <Input id="due_date" type="date" value={formData.due_date} onChange={(e) => setFormData({ ...formData, due_date: e.target.value })} required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="salesperson">Salesperson</Label>
              <Select value={formData.salesperson_id || user?.id || ""} onValueChange={(value) => setFormData({ ...formData, salesperson_id: value })}>
                <SelectTrigger><SelectValue placeholder="Select salesperson" /></SelectTrigger>
                <SelectContent>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>{m.full_name || m.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FieldGrid>
        </FieldGroup>

        {/* Project — only when the Projects app is installed for this org. */}
        <CapabilityGate cap="projects.analytic-tagging">
          <FieldGroup label="Project">
            <ProjectPicker
              enabled={open}
              value={formData.project_id}
              onChange={(id) => setFormData({ ...formData, project_id: id })}
              customerId={formData.contact_id || null}
              helperText="Optional — links this invoice's revenue to project profitability."
            />
          </FieldGroup>
        </CapabilityGate>

        {/* Line Items — one container-adaptive editor for every viewport. */}
        <FieldGroup label="Line Items">
          <EditableLineItemsGrid
            columns={INVOICE_LINE_COLUMNS}
            rows={lineItems}
            containerRef={linesTableRef}
            disabled={isSubmitting}
            addLabel="Add Item"
            onAddRow={addLineItem}
            onRemoveRow={removeLineItem}
            toolbar={
              <DocumentLineScanner
                documentLabel="Invoice"
                businessId={currentBusiness?.id}
                branchId={currentBranch?.id ?? null}
                onResolved={handleScanResolved}
                onSessionCommit={handleScanSessionCommit}
                openSessionOnMount={openScanSessionOnMount}
                linesTableRef={linesTableRef}
                disabled={isSubmitting}
              />
            }
            renderRow={(item, index, layout) => (
              <InvoiceLineRow
                  unitsFor={unitsFor}
                index={index}
                item={item}
                products={products}
                layout={layout}
                flashed={flashIndex === index}
                isSubmitting={isSubmitting}
                stockEval={lineStockEvals[index] ?? null}
                headerProjectId={formData.project_id}
                customerId={formData.contact_id || null}
                formatCurrency={formatCurrency}
                onProductSelect={handleProductSelect}
                onUpdate={updateLineItem}
              />
            )}
          />


          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-full sm:w-64 space-y-2">
              <div className="flex justify-between text-sm"><span>Subtotal</span><span>{formatCurrency(subtotal)}</span></div>
              <div className="flex justify-between text-sm"><span>Tax</span><span>{formatCurrency(taxTotal)}</span></div>
              <div className="flex justify-between items-center text-sm">
                <span>Discount</span>
                <Input type="number" step="0.01" min="0" value={formData.discount_amount} onChange={(e) => setFormData({ ...formData, discount_amount: parseFloat(e.target.value) || 0 })} className="h-8 w-24 text-right" />
              </div>
              <div className="flex justify-between text-lg font-bold border-t pt-2"><span>Total</span><span>{formatCurrency(grandTotal)}</span></div>
            </div>
          </div>
        </FieldGroup>

        {/* Additional Info */}
        <FieldGroup label="Additional Info">
          <FieldGrid columns={2}>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="notes">Notes</Label>
                <AITextAssist fieldType="notes" documentType="invoice" currentValue={formData.notes} onApply={(text) => setFormData({ ...formData, notes: text })} customerName={customers.find(c => c.id === formData.contact_id)?.name} totalAmount={grandTotal} currency={formData.currency || baseCurrency} />
              </div>
              <Textarea id="notes" value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} rows={3} placeholder="Notes visible to customer..." />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="terms">Terms</Label>
                <AITextAssist fieldType="terms" documentType="invoice" currentValue={formData.terms} onApply={(text) => setFormData({ ...formData, terms: text })} customerName={customers.find(c => c.id === formData.contact_id)?.name} totalAmount={grandTotal} currency={formData.currency || baseCurrency} />
              </div>
              <Textarea id="terms" value={formData.terms} onChange={(e) => setFormData({ ...formData, terms: e.target.value })} rows={3} placeholder="Payment terms..." />
            </div>
          </FieldGrid>
        </FieldGroup>

        <CustomFieldsSection entityType="invoice" entityId={null} formValues={formData} disabled={isSubmitting} />

        {/* Oversell confirmation — required when any line exceeds available stock */}
        <OversellConfirmation
          kind="invoice"
          availability={availability}
          disabled={isSubmitting}
        />

        {/* Mark as sent checkbox — stays in body */}
        <div className="flex items-center space-x-2">
          <Checkbox id="markAsSent" checked={formData.markAsSent} onCheckedChange={(checked) => setFormData({ ...formData, markAsSent: checked === true })} disabled={isSubmitting} />
          <Label htmlFor="markAsSent" className="text-sm font-normal cursor-pointer">Mark as sent immediately</Label>
        </div>
      </div>
    </RecordFormShell>

  );
}
