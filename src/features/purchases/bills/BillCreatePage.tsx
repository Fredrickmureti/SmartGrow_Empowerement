/**
 * BillCreatePage — full-page create route at `/purchases/bills/new`.
 *
 * Retires the last Bills create dialog by hosting supplier, dates, line
 * items, totals, analytics, and notes on the enterprise RecordFormShell.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { toast } from "sonner";

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
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { PricedLineRow, PRICED_LINE_COLUMNS } from "@/components/documents/lines/PricedLineRow";
import { DocumentLineScanner } from "@/components/documents/lines/DocumentLineScanner";
import {
  usePricedLineScan,
  scanCostPrice,
  scanTaxRate,
} from "@/features/sales/scan-session/useDocumentLineScan";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { LineAnalyticsCell } from "@/components/projects/LineAnalyticsCell";
import { LineAccountCell } from "@/components/documents/lines/LineAccountCell";
import { CapabilityGate } from "@/components/apps/CapabilityGate";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { supabase } from "@/integrations/supabase/client";
import { useBills, type Bill, type BillItem, type DuplicateVendorInvoice } from "@/hooks/useBills";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { usePaymentTerms } from "@/hooks/usePaymentTerms";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import {
  resolvePaymentTerm,
  dueDateFromTerm,
} from "@/services/finance/paymentTerms";
import { normalizeError } from "@/services/resilience";
import { usePurchasableVendors } from "@/features/purchases/suppliers/usePurchasableVendors";

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

const calculateLineTotal = (item: LineItem) => {
  const subtotal = item.quantity * item.unit_price;
  return { lineTotal: subtotal, taxAmount: subtotal * ((item.tax_rate || 0) / 100) };
};

export default function BillCreatePage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Handheld list pages deep-link here with `openScanSession` so the
  // camera sheet opens immediately (see ScanToDocumentButton).
  const openScanSessionOnMount =
    ((location.state as { openScanSession?: boolean } | null)?.openScanSession) === true;
  const [searchParams] = useSearchParams();
  const prefillContactId = searchParams.get("contact_id") ?? "";
  const prefillProjectId = searchParams.get("project_id");
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency } = useCurrency();
  const { paymentTerms } = usePaymentTerms();
  const {
    getNextBillNumber,
    createBill,
    getDefaultDueDate,
    findDuplicateVendorInvoice,
    requireBillApproval,
  } = useBills();
  // Duplicate supplier-invoice warning (C1). The DB trigger is the hard stop;
  // this surfaces the clashing bill before the user submits.
  const [duplicates, setDuplicates] = useState<DuplicateVendorInvoice[]>([]);

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
  /** Vendor tier of the purchase account ladder (ADR 0122). */
  const [vendorExpenseAccountId, setVendorExpenseAccountId] = useState<string | null>(null);

  const vendors = usePurchasableVendors(contacts);

  // ADR 0135 — supplier-proposed currency; the database stamps and freezes it.
  const { currency: documentCurrency } = useSupplierDocumentCurrency(formData.vendor_id);

  useEffect(() => {
    if (prefillContactId) {
      void handleVendorChange(prefillContactId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillContactId]);

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

  const selectProduct = useCallback(
    (index: number, productId: string) => {
      const product = products.find((p) => p.id === productId);
      patchLineItem(index, {
        product_id: productId,
        ...(product
          ? {
              description: product.name,
              unit_price: product.cost_price || product.unit_price,
              tax_rate: product.tax_rate || 0,
            }
          : {}),
      });
    },
    [products, patchLineItem],
  );

  // Scan-to-line — shared workspace transport, cost-priced seed.
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { handleScanResolved, handleScanSessionCommit, flashIndex } = usePricedLineScan(
    setLineItems,
    (resolved, quantity, lines) => {
      const unit_price = scanCostPrice(resolved);
      const tax_rate = scanTaxRate(resolved);
      const subtotal = quantity * unit_price;
      return {
        account_id: null,
        product_id: resolved.productId,
        description: resolved.name,
        quantity,
        unit_price,
        tax_rate,
        tax_amount: subtotal * (tax_rate / 100),
        line_total: subtotal,
        sort_order: lines.length,
        project_id: null,
        task_id: null,
      } as unknown as LineItem;
    },
  );

  const addLineItem = useCallback(
    () => setLineItems((prev) => [...prev, emptyLine(prev.length)]),
    [],
  );

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }, []);


  const handleVendorChange = async (vendorId: string) => {
    setFormData((prev) => ({ ...prev, vendor_id: vendorId }));
    if (!vendorId) return;
    try {
      const defaults = await fetchContactDefaults(vendorId);
      setVendorExpenseAccountId(defaults.default_expense_account_id ?? null);
      // Supplier term -> company default -> due on receipt, resolved server
      // side by the one canonical rule.
      const resolved = await resolvePaymentTerm({
        organizationId: currentBusiness?.organization_id,
        businessId: currentBusiness?.id,
        contactId: vendorId,
      });
      setFormData((prev) => ({
        ...prev,
        payment_term_id: resolved?.payment_term_id ?? "",
        due_date: dueDateFromTerm(prev.bill_date, resolved?.days ?? 0),
      }));
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

  // Debounced duplicate lookup on (supplier, vendor invoice #).
  useEffect(() => {
    const vendorId = formData.vendor_id;
    const ref = formData.vendor_invoice_number.trim();
    if (!vendorId || !ref) {
      setDuplicates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const rows = await findDuplicateVendorInvoice(vendorId, ref);
      if (!cancelled) setDuplicates(rows);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // findDuplicateVendorInvoice is stable enough (derives from org context).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.vendor_id, formData.vendor_invoice_number]);

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
          payment_term_id: formData.payment_term_id || null,
          subtotal: 0,
          tax_amount: 0,
          discount_amount: formData.discount_amount,
          total: 0,
          amount_paid: 0,
          currency: documentCurrency,
          notes: formData.notes || null,
          attachment_url: null,
          project_id: formData.project_id,
        } as Omit<Bill, "id" | "organization_id" | "business_id" | "branch_id" | "created_at" | "updated_at" | "created_by" | "vendor" | "items" | "currency_rate" | "company_currency_total">,
        validItems,
      );
      toast.success(
        requireBillApproval
          ? "Bill created and submitted for approval"
          : "Bill created and posted to accounts payable",
      );
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
              aria-invalid={duplicates.length > 0}
            />
            {duplicates.length > 0 && (
              <p className="text-xs text-destructive" role="alert">
                Possible duplicate: this supplier already has{" "}
                {duplicates
                  .map((d) => `${d.bill_number} (${d.bill_date}, ${d.status})`)
                  .join(", ")}
                . Saving may be blocked by company policy.
              </p>
            )}
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
            <CapabilityGate cap="projects.analytic-tagging">
              <ProjectPicker
                enabled
                value={formData.project_id}
                onChange={(projectId) =>
                  setFormData({ ...formData, project_id: projectId })
                }
                helperText="Optional — links this bill's costs to project profitability."
              />
            </CapabilityGate>
          </div>
        </FieldGrid>
      </FieldGroup>

      <FieldGroup label="Line items">
        <EditableLineItemsGrid
          columns={PRICED_LINE_COLUMNS}
          rows={lineItems}
          toolbar={
            <DocumentLineScanner
              documentLabel="Bill"
              businessId={currentBusiness?.id}
              branchId={currentBranch?.id ?? null}
              onResolved={handleScanResolved}
              onSessionCommit={handleScanSessionCommit}
              openSessionOnMount={openScanSessionOnMount}
              disabled={isSubmitting}
            />
          }
          onAddRow={addLineItem}
          onRemoveRow={removeLineItem}
          addLabel="Add item"
          disabled={isSubmitting}
          renderRow={(item, index, layout) => (
            <PricedLineRow
              key={index}
              index={index}
              item={item}
              flashed={flashIndex === index}
              products={products}
              layout={layout}
              disabled={isSubmitting}
              formatCurrency={formatCurrency}
              onPatch={patchLineItem}
              onProductSelect={selectProduct}
              productPlaceholder="Product (optional)"
              extra={
                <div className="space-y-2">
                  <LineAnalyticsCell
                    projectId={item.project_id ?? null}
                    taskId={item.task_id ?? null}
                    headerProjectId={formData.project_id}
                    onChange={(next) =>
                      patchLineItem(index, {
                        project_id: next.project_id,
                        task_id: next.task_id,
                      })
                    }
                    disabled={isSubmitting}
                  />
                  <LineAccountCell
                    value={item.account_id}
                    onChange={(account_id) => patchLineItem(index, { account_id })}
                    product={products.find((p) => p.id === item.product_id) ?? null}
                    vendorExpenseAccountId={vendorExpenseAccountId}
                    disabled={isSubmitting}
                  />
                </div>
              }
            />
          )}
          footer={
            <div className="flex justify-end">
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
          }
        />
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