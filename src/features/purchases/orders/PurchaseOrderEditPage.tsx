/**
 * PurchaseOrderEditPage — full-page editor for a Purchase Order.
 *
 * Replaces the legacy `EditPODialog` (raw `<Sheet>`) with a `RecordShell`
 * route at `/purchases/orders/:id/edit`. Form logic is preserved verbatim
 * from the retired dialog; footer actions move to `FooterActionBar`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

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
import { useToast } from "@/hooks/use-toast";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useVendorPriceLists } from "@/hooks/useVendorPriceLists";
import {
  usePurchaseOrders,
  type PurchaseOrder,
  type PurchaseOrderItem,
} from "@/hooks/usePurchaseOrders";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { LineAnalyticsCell } from "@/components/projects/LineAnalyticsCell";
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
import {
  resolvePurchaseLineDefaults,
  summarisePurchaseLineRefusals,
  validatePurchaseLinesAgainstTerms,
} from "@/features/purchases/purchasingTerms/purchaseLineTerms";
import { DeliverToPicker } from "@/components/addresses/DeliverToPicker";
import { useBranches } from "@/hooks/useBranches";
import { usePurchasableVendors } from "@/features/purchases/suppliers/usePurchasableVendors";
import {
  useSupplierContracts,
  contractRemaining,
  findContractLine,
} from "@/features/purchases/contracts/useSupplierContracts";

type LineItem = Omit<PurchaseOrderItem, "id" | "purchase_order_id">;

/**
 * Statuses whose commercial terms may still be edited. Mirrors the
 * update_po_items_atomic guard and trg_po_commercial_fields_immutable:
 * once a PO leaves this set, editing goes through Revise on the record page.
 */
const PO_EDITABLE_STATUSES = new Set(["draft", "revised", "rejected"]);

export default function PurchaseOrderEditPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { currentBusiness } = useBusinesses();
  const currentBusinessId = currentBusiness?.id ?? null;
  const { formatCurrency } = useCurrency();
  const {
    purchaseOrders,
    isLoading,
    updatePurchaseOrder,
    refreshPurchaseOrders,
  } = usePurchaseOrders();

  const po = useMemo(
    () => purchaseOrders.find((p) => p.id === id) ?? null,
    [purchaseOrders, id],
  );

  const vendors = usePurchasableVendors(contacts);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    vendor_id: "",
    order_date: "",
    expected_date: "",
    // OUR receiving location (structured), plus the printed snapshot.
    deliver_to_warehouse_id: null as string | null,
    deliver_to_branch_id: null as string | null,
    shipping_address: "",
    notes: "",
    discount_amount: 0,
    project_id: null as string | null,
    contract_id: null as string | null,
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [primed, setPrimed] = useState(false);

  const { priceLists } = useVendorPriceLists(formData.vendor_id || undefined);
  // Contract draw-down — same rule as create: one supplier agreement per PO,
  // re-validated by the ceiling trigger on approval.
  const { contracts } = useSupplierContracts(formData.vendor_id || null);
  const selectedContract = contracts.find((c) => c.id === formData.contract_id);

  const applyContract = (nextId: string) => {
    const next = nextId === "none" ? null : nextId;
    setFormData((prev) => ({ ...prev, contract_id: next }));
    const contract = contracts.find((c) => c.id === next);
    setLineItems((prev) =>
      prev.map((item: any) => {
        const line = findContractLine(contract, item.product_id);
        if (!line) return { ...item, contract_line_id: null };
        const unit_price = line.unit_price ?? item.unit_price;
        const subtotal = (item.quantity || 0) * unit_price;
        return {
          ...item,
          contract_line_id: line.id,
          unit_price,
          line_total: subtotal,
          tax_amount: subtotal * ((item.tax_rate || 0) / 100),
        };
      }),
    );
  };

  useEffect(() => {
    if (!po || primed) return;
    setFormData({
      vendor_id: po.vendor_id || "",
      order_date: po.order_date,
      expected_date: po.expected_date || "",
      deliver_to_warehouse_id:
        (po as unknown as { deliver_to_warehouse_id?: string | null })
          .deliver_to_warehouse_id ?? null,
      deliver_to_branch_id:
        (po as unknown as { deliver_to_branch_id?: string | null })
          .deliver_to_branch_id ?? null,
      shipping_address: po.shipping_address || "",
      notes: po.notes || "",
      discount_amount: po.discount_amount || 0,
      project_id:
        (po as unknown as { project_id?: string | null }).project_id ?? null,
      contract_id:
        (po as unknown as { contract_id?: string | null }).contract_id ?? null,
    });
    setLineItems(
      po.items && po.items.length > 0
        ? po.items.map((item: any) => ({
            product_id: item.product_id,
            description: item.description,
            quantity: item.quantity,
            quantity_received: item.quantity_received,
            unit_price: item.unit_price,
            tax_rate: item.tax_rate,
            tax_amount: item.tax_amount,
            line_total: item.line_total,
            sort_order: item.sort_order,
            contract_line_id: item.contract_line_id ?? null,
            project_id: item.project_id ?? null,
            task_id: item.task_id ?? null,
            packaging_id: item.packaging_id ?? null,
            display_quantity: item.display_quantity ?? null,
            display_uom_id: item.display_uom_id ?? null,
          }))
        : [
            {
              product_id: null,
              description: "",
              quantity: 1,
              quantity_received: 0,
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
  }, [po, primed]);

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
      const vendorPrice = priceLists.find((pl) => pl.product_id === productId);
      // Contract price outranks the vendor price list — it is the rate the
      // ceiling trigger enforces.
      const contractLine = findContractLine(selectedContract, productId);
      patchLineItem(index, {
        product_id: productId,
        contract_line_id: contractLine?.id ?? null,
        ...(product
          ? {
              description: product.name,
              unit_price:
                contractLine?.unit_price ??
                (vendorPrice
                  ? vendorPrice.unit_price
                  : product.cost_price || product.unit_price),
              tax_rate: product.tax_rate || 0,
            }
          : {}),
      } as Partial<LineItem>);

      // Supplier purchasing terms (ADR 0141) seed the line server-side.
      void (async () => {
        try {
          const defaults = await resolvePurchaseLineDefaults({
            businessId: currentBusinessId,
            productId,
            supplierId: formData.vendor_id || null,
            onDate: formData.order_date || null,
          });
          if (!defaults) return;
          patchLineItem(index, {
            quantity: defaults.quantity,
            display_uom_id: defaults.displayUomId,
          } as Partial<LineItem>);
        } catch {
          // Advisory at entry time; the submit gate below is authoritative.
        }
      })();
    },
    [
      products,
      priceLists,
      patchLineItem,
      selectedContract,
      currentBusinessId,
      formData.vendor_id,
      formData.order_date,
    ],
  );

  // Scan-to-line — shared workspace transport, cost-priced seed.
  const { currentBranch } = useBranches();
  const { handleScanResolved, handleScanSessionCommit, flashIndex } = usePricedLineScan(
    setLineItems,
    (resolved, quantity, lines) => {
      const unit_price = scanCostPrice(resolved);
      const tax_rate = scanTaxRate(resolved);
      const subtotal = quantity * unit_price;
      return {
        product_id: resolved.productId,
        description: resolved.name,
        quantity,
        quantity_received: 0,
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
        product_id: null,
        description: "",
        quantity: 1,
        quantity_received: 0,
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
    if (!po) return;
    setIsSubmitting(true);
    try {
      const validItems = lineItems.filter((item) => item.description);
      // Purchasing policy is enforced before the order is rewritten.
      const refusals = await validatePurchaseLinesAgainstTerms({
        businessId: currentBusinessId,
        supplierId: formData.vendor_id,
        onDate: formData.order_date || null,
        lines: validItems.map((item, index) => ({
          index,
          productId: item.product_id,
          quantity: Number(item.quantity),
          productName: item.description,
        })),
      });
      if (refusals.length > 0) {
        toast({
          title: "Supplier purchasing terms",
          description: summarisePurchaseLineRefusals(refusals),
          variant: "destructive",
        });
        setIsSubmitting(false);
        return;
      }
      await updatePurchaseOrder(
        po.id,
        {
          vendor_id: formData.vendor_id || null,
          order_date: formData.order_date,
          expected_date: formData.expected_date || null,
          deliver_to_warehouse_id: formData.deliver_to_warehouse_id,
          deliver_to_branch_id: formData.deliver_to_branch_id,
          shipping_address: formData.shipping_address || null,
          notes: formData.notes || null,
          discount_amount: formData.discount_amount,
          project_id: formData.project_id,
          contract_id: formData.contract_id,
        } as Partial<PurchaseOrder>,
        validItems,
      );
      toast({ title: "Purchase order updated" });
      refreshPurchaseOrders();
      navigate(`/purchases/orders/${po.id}`);
    } catch (error: any) {
      toast({
        title: "Error updating PO",
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

  if (isLoading && !po) {
    return (
      <RecordShell
        header={<RecordHeader eyebrow="Purchase Order" title="Loading…" />}
      >
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (!po) {
    return (
      <RecordShell
        header={
          <RecordHeader eyebrow="Purchase Order" title="Purchase order" />
        }
      >
        <Section>
          <ErrorState
            title="Purchase order not found"
            description="It may have been deleted or you don't have access."
            onRetry={() => navigate("/purchases/orders")}
          />
        </Section>
      </RecordShell>
    );
  }

  // Client-side twin of the update_po_items_atomic guard: commercial terms
  // lock once a PO leaves draft/revised/rejected. Show an explanation and a
  // path back instead of an editable form that would fail on save.
  if (po && !PO_EDITABLE_STATUSES.has(po.status)) {
    return (
      <RecordShell
        header={
          <RecordHeader eyebrow="Edit Purchase Order" title={po.po_number} />
        }
      >
        <Section>
          <ErrorState
            title={`${po.po_number} can't be edited`}
            description={`This purchase order is "${po.status}". Commercial terms are locked once a PO leaves draft — use Revise on the record page to reopen it for editing.`}
            onRetry={() => navigate(`/purchases/orders/${po.id}`)}
          />
        </Section>
      </RecordShell>
    );
  }

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Edit Purchase Order"
          title={po.vendor?.name ?? "Vendor"}
          docNumber={po.po_number}
          actions={
            <ActionBar>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/purchases/orders/${po.id}`)}
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
              onClick={() => navigate(`/purchases/orders/${po.id}`)}
            >
              Cancel
            </Button>
          }
          trailing={
            <Button onClick={() => handleSubmit()} disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save Changes"}
            </Button>
          }
        />
      }
    >
      <form onSubmit={handleSubmit} className="space-y-6 pb-24">
        <Section title="Order details">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Supplier *</Label>
              <Select
                value={formData.vendor_id}
                onValueChange={(v) => {
                  // Contracts are supplier-specific — drop coverage on change.
                  setFormData({ ...formData, vendor_id: v, contract_id: null });
                  setLineItems((prev) =>
                    prev.map((i: any) => ({ ...i, contract_line_id: null })),
                  );
                }}
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
              <Label>Order date</Label>
              <Input
                type="date"
                value={formData.order_date}
                onChange={(e) =>
                  setFormData({ ...formData, order_date: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Contract</Label>
              <Select
                value={formData.contract_id || "none"}
                onValueChange={applyContract}
                disabled={!formData.vendor_id}
              >
                <SelectTrigger>
                  <SelectValue placeholder="No contract" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No contract (spot buy)</SelectItem>
                  {contracts.map((c) => {
                    const remaining = contractRemaining(c);
                    return (
                      <SelectItem key={c.id} value={c.id}>
                        {c.contract_number} — {c.title}
                        {remaining != null ? ` · ${remaining.toLocaleString()} left` : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {selectedContract && (
                <p className="text-xs text-muted-foreground">
                  Agreed prices and ceilings of {selectedContract.contract_number} are enforced on
                  approval.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Expected delivery</Label>
              <Input
                type="date"
                value={formData.expected_date}
                onChange={(e) =>
                  setFormData({ ...formData, expected_date: e.target.value })
                }
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <DeliverToPicker
                businessId={currentBusiness?.id}
                value={{
                  deliverToWarehouseId: formData.deliver_to_warehouse_id,
                  deliverToBranchId: formData.deliver_to_branch_id,
                  shippingAddress: formData.shipping_address,
                }}
                onChange={(next) =>
                  setFormData((prev) => ({
                    ...prev,
                    deliver_to_warehouse_id: next.deliverToWarehouseId,
                    deliver_to_branch_id: next.deliverToBranchId,
                    shipping_address: next.shippingAddress,
                  }))
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
                  helperText="Optional — links this PO's costs to project profitability."
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
                documentLabel="Purchase order"
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
                onPatch={patchLineItem}
                onProductSelect={selectProduct}
                productPlaceholder="Product"
                extra={
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
          />
        </Section>
      </form>
    </RecordShell>
  );
}