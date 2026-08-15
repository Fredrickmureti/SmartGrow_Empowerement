/**
 * BillEditPage — full-page editor for a Bill.
 *
 * Replaces the legacy `EditBillDialog` (raw `<Sheet>`) with a
 * `RecordShell` route at `/purchases/bills/:id/edit`. Preserves the
 * fiscal-period lock guard and payment-term auto-due-date logic.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import { ArrowLeft, Lock } from "lucide-react";

import {
  ActionBar,
  ErrorState,
  FooterActionBar,
  LoadingState,
  RecordHeader,
  RecordShell,
  Section,
} from "@/design-system";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { usePaymentTerms } from "@/hooks/usePaymentTerms";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import {
  useBills,
  type Bill,
  type BillItem,
  type DuplicateVendorInvoice,
} from "@/hooks/useBills";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { LineAnalyticsCell } from "@/components/projects/LineAnalyticsCell";
import { LineAccountCell } from "@/components/documents/lines/LineAccountCell";
import { fetchContactDefaults } from "@/lib/fetchContactDefaults";
import { CapabilityGate } from "@/components/apps/CapabilityGate";
import { normalizeError } from "@/services/resilience";
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
import { usePurchasableVendors } from "@/features/purchases/suppliers/usePurchasableVendors";

type LineItem = Omit<BillItem, "id" | "bill_id">;

export default function BillEditPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const unitsFor = useUnitsForProducts(products);
  const { formatCurrency } = useCurrency();
  const { paymentTerms } = usePaymentTerms();
  const { isDateLocked } = useFiscalPeriods();
  const { bills, isLoading, updateBill, findDuplicateVendorInvoice } = useBills();

  const bill = useMemo(
    () => bills.find((b) => b.id === id) ?? null,
    [bills, id],
  );

  const vendors = usePurchasableVendors(contacts);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    vendor_id: "",
    vendor_invoice_number: "",
    bill_date: "",
    due_date: "",
    notes: "",
    discount_amount: 0,
    payment_term_id: "",
    project_id: null as string | null,
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [primed, setPrimed] = useState(false);
  /**
   * Friendly duplicate warning on (supplier, vendor invoice #), excluding the
   * bill being edited. The DB trigger is still the hard guarantee.
   */
  const [duplicates, setDuplicates] = useState<DuplicateVendorInvoice[]>([]);
  /** Vendor tier of the purchase account ladder (ADR 0122). */
  const [vendorExpenseAccountId, setVendorExpenseAccountId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!formData.vendor_id) {
      setVendorExpenseAccountId(null);
      return;
    }
    fetchContactDefaults(formData.vendor_id)
      .then((d) => {
        if (!cancelled) setVendorExpenseAccountId(d.default_expense_account_id ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [formData.vendor_id]);

  // Debounced duplicate lookup on (supplier, vendor invoice #), self-excluded.
  useEffect(() => {
    const vendorId = formData.vendor_id;
    const ref = formData.vendor_invoice_number.trim();
    if (!vendorId || !ref) {
      setDuplicates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const rows = await findDuplicateVendorInvoice(vendorId, ref, id);
      if (!cancelled) setDuplicates(rows);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.vendor_id, formData.vendor_invoice_number, id]);

  useEffect(() => {
    if (!bill || primed) return;
    setFormData({
      vendor_id: bill.vendor_id || "",
      vendor_invoice_number: bill.vendor_invoice_number || "",
      bill_date: bill.bill_date,
      due_date: bill.due_date,
      notes: bill.notes || "",
      discount_amount: bill.discount_amount || 0,
      payment_term_id: "",
      project_id:
        (bill as unknown as { project_id?: string | null }).project_id ?? null,
    });
    setLineItems(
      bill.items && bill.items.length > 0
        ? bill.items.map((item: any) => ({
            account_id: item.account_id,
            product_id: item.product_id,
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            tax_rate: item.tax_rate,
            tax_amount: item.tax_amount,
            line_total: item.line_total,
            sort_order: item.sort_order,
            project_id: item.project_id ?? null,
            task_id: item.task_id ?? null,
            packaging_id: item.packaging_id ?? null,
            display_quantity: item.display_quantity ?? null,
            display_uom_id: item.display_uom_id ?? null,
          }))
        : [
            {
              account_id: null,
              product_id: null,
              description: "",
              quantity: 1,
              unit_price: 0,
              tax_rate: 0,
              tax_amount: 0,
              line_total: 0,
              sort_order: 0,
              project_id: null,
              task_id: null,
            } as any,
          ],
    );
    setPrimed(true);
  }, [bill, primed]);

  const handlePaymentTermChange = (termId: string) => {
    setFormData((prev) => {
      const term = paymentTerms.find((t) => t.id === termId);
      if (term && prev.bill_date) {
        const billDate = new Date(prev.bill_date);
        billDate.setDate(billDate.getDate() + term.days);
        return {
          ...prev,
          payment_term_id: termId,
          due_date: billDate.toISOString().split("T")[0],
        };
      }
      return { ...prev, payment_term_id: termId };
    });
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
      } as Partial<LineItem>);
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

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [
      ...prev,
      {
        account_id: null,
        product_id: null,
        description: "",
        quantity: 1,
        unit_price: 0,
        tax_rate: 0,
        tax_amount: 0,
        line_total: 0,
        sort_order: prev.length,
        project_id: null,
        task_id: null,
      } as any,
    ]);
  }, []);

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }, []);


  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!bill) return;
    setIsSubmitting(true);
    try {
      const validItems = lineItems.filter((item) => item.description);
      await updateBill(
        bill.id,
        {
          vendor_id: formData.vendor_id || null,
          vendor_invoice_number: formData.vendor_invoice_number || null,
          bill_date: formData.bill_date,
          due_date: formData.due_date,
          notes: formData.notes || null,
          discount_amount: formData.discount_amount,
          project_id: formData.project_id,
        } as Partial<Bill>,
        validItems,
      );
      toast({ title: "Bill updated successfully" });
      navigate(`/purchases/bills/${bill.id}`);
    } catch (error: any) {
      toast({
        title: "Error updating bill",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const subtotal = lineItems.reduce((sum, item) => sum + item.line_total, 0);
  const totalTax = lineItems.reduce((sum, item) => sum + item.tax_amount, 0);
  const grandTotal = subtotal + totalTax - formData.discount_amount;
  const dateLocked =
    !!formData.bill_date && isDateLocked(formData.bill_date);

  if (isLoading && !bill) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Bill" title="Loading…" />}>
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (!bill) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Bill" title="Bill" />}>
        <Section>
          <ErrorState
            title="Bill not found"
            description="It may have been deleted or you don't have access."
            onRetry={() => navigate("/purchases/bills")}
          />
        </Section>
      </RecordShell>
    );
  }

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Edit Bill"
          title={bill.vendor?.name ?? "Vendor"}
          docNumber={bill.bill_number}
          actions={
            <ActionBar>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/purchases/bills/${bill.id}`)}
              >
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
            </ActionBar>
          }
        />
      }
      footer={
        <FooterActionBar
          leading={
            <Button
              variant="outline"
              onClick={() => navigate(`/purchases/bills/${bill.id}`)}
            >
              Cancel
            </Button>
          }
          trailing={
            <Button
              onClick={() => handleSubmit()}
              disabled={isSubmitting || dateLocked}
            >
              {isSubmitting ? "Saving…" : "Save Changes"}
            </Button>
          }
        />
      }
    >
      <form onSubmit={handleSubmit} className="space-y-6 pb-24">
        <Section title="Bill details">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Supplier *</Label>
              <Select
                value={formData.vendor_id}
                onValueChange={(v) =>
                  setFormData({ ...formData, vendor_id: v })
                }
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
              <Label>Vendor invoice #</Label>
              <Input
                value={formData.vendor_invoice_number}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    vendor_invoice_number: e.target.value,
                  })
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
                onChange={(e) =>
                  setFormData({ ...formData, bill_date: e.target.value })
                }
              />
              {dateLocked && (
                <Alert variant="destructive" className="py-2">
                  <Lock className="h-3.5 w-3.5" />
                  <AlertDescription className="text-xs">
                    Fiscal period for{" "}
                    {format(new Date(formData.bill_date), "MMM d, yyyy")} is
                    closed — saving will fail.
                  </AlertDescription>
                </Alert>
              )}
            </div>
            <div className="space-y-2">
              <Label>Payment terms</Label>
              <Select
                value={formData.payment_term_id}
                onValueChange={handlePaymentTermChange}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select terms (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {paymentTerms.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.days} days)
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
                onChange={(e) =>
                  setFormData({ ...formData, due_date: e.target.value })
                }
              />
            </div>
            <div className="md:col-span-2">
              <CapabilityGate cap="projects.analytic-tagging">
                <ProjectPicker
                  enabled
                  value={formData.project_id}
                  onChange={(id) =>
                    setFormData({ ...formData, project_id: id })
                  }
                  helperText="Optional — links this bill's costs to project profitability."
                />
              </CapabilityGate>
            </div>
          </div>
        </Section>

        <Section title="Line items">
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
                unitsFor={unitsFor}
                onPatch={patchLineItem}
                onProductSelect={selectProduct}
                productPlaceholder="Product"
                extra={
                  <div className="space-y-2">
                    <LineAnalyticsCell
                      projectId={(item as any).project_id ?? null}
                      taskId={(item as any).task_id ?? null}
                      headerProjectId={formData.project_id}
                      onChange={(next) =>
                        patchLineItem(index, {
                          project_id: next.project_id,
                          task_id: next.task_id,
                        } as Partial<LineItem>)
                      }
                      disabled={isSubmitting}
                    />
                    <LineAccountCell
                      value={item.account_id}
                      onChange={(account_id) =>
                        patchLineItem(index, { account_id } as Partial<LineItem>)
                      }
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
                <div className="w-64 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>Subtotal:</span>
                    <span className="tabular-nums">{formatCurrency(subtotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tax:</span>
                    <span className="tabular-nums">{formatCurrency(totalTax)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Discount:</span>
                    <Input
                      type="number"
                      className="h-8 w-24"
                      value={formData.discount_amount}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          discount_amount: parseFloat(e.target.value) || 0,
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
        </Section>


        <Section title="Notes">
          <Textarea
            value={formData.notes}
            onChange={(e) =>
              setFormData({ ...formData, notes: e.target.value })
            }
            placeholder="Internal notes…"
          />
        </Section>
      </form>
    </RecordShell>
  );
}