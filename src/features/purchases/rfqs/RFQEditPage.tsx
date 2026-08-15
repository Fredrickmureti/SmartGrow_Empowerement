/**
 * RFQEditPage — `/purchases/rfqs/:id/edit`.
 *
 * Only draft RFQs are editable (the underlying updateRFQ mutation
 * enforces this at the persistence layer; the UI redirects non-drafts
 * to the record page so the user is never stuck on a form they can't
 * save).
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { ErrorState, LoadingState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { RequestLineRow, REQUEST_LINE_COLUMNS } from "@/components/documents/lines/RequestLineRow";
import { DocumentLineScanner } from "@/components/documents/lines/DocumentLineScanner";
import { useDocumentLineScan } from "@/features/sales/scan-session/useDocumentLineScan";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useRFQs, type RFQItem } from "@/hooks/useRFQs";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useUnitsForProducts } from "@/hooks/useSellableUnits";
import { useCurrency } from "@/hooks/useCurrency";
import { useRFQRecord } from "./useRFQRecord";
import { usePurchasableVendors } from "@/features/purchases/suppliers/usePurchasableVendors";

type LineItem = Omit<RFQItem, "id" | "rfq_id">;

const emptyLine = (sort_order = 0): LineItem => ({
  product_id: null,
  description: "",
  quantity: 1,
  target_price: null,
  sort_order,
});

export default function RFQEditPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { record, loading, error } = useRFQRecord(id);
  const { updateRFQAsync, isUpdating } = useRFQs();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const unitsFor = useUnitsForProducts(products);
  const { formatCurrency, baseCurrency } = useCurrency();

  const [deadline, setDeadline] = useState("");
  const [requiredBy, setRequiredBy] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedVendorIds, setSelectedVendorIds] = useState<string[]>([]);
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine(0)]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!record || hydrated) return;
    if (record.status !== "draft") {
      toast.error("Only draft RFQs are editable");
      navigate(`/purchases/rfqs/${id}`, { replace: true });
      return;
    }
    setDeadline(record.deadline ? record.deadline.slice(0, 10) : "");
    setRequiredBy(record.required_by_date ? record.required_by_date.slice(0, 10) : "");
    setNotes(record.notes ?? "");
    setSelectedVendorIds(
      (record.invitations ?? []).map((inv: any) => inv.supplier_id).filter(Boolean),
    );
    const items = ((record.items ?? []) as any[])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    setLineItems(
      items.length > 0
        ? items.map((i, idx) => ({
            product_id: i.product_id,
            description: i.description ?? "",
            quantity: i.quantity ?? 1,
            packaging_id: i.packaging_id ?? null,
            display_quantity: i.display_quantity ?? null,
            display_uom_id: i.display_uom_id ?? null,
            target_price: i.target_price ?? null,
            sort_order: idx,
          }))
        : [emptyLine(0)],
    );
    setHydrated(true);
  }, [record, hydrated, id, navigate]);

  const vendors = usePurchasableVendors(contacts);

  const patchLineItem = useCallback((index: number, patch: Partial<LineItem>) => {
    setLineItems((prev) =>
      prev.map((line, i) => (i === index ? ({ ...line, ...patch } as LineItem) : line)),
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
              target_price: product.cost_price || product.unit_price || null,
            }
          : {}),
      } as Partial<LineItem>);
    },
    [products, patchLineItem],
  );

  const formatLineCurrency = useCallback(
    (n: number) => formatCurrency(n, baseCurrency),
    [formatCurrency, baseCurrency],
  );

  // Scan-to-line — RFQ lines carry no committed price, so a scan only
  // identifies the item and its quantity; the target price stays the
  // buyer's judgement call.
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { handleScanResolved, handleScanSessionCommit, flashIndex } = useDocumentLineScan<LineItem>({
    setLines: setLineItems,
    matchLine: (line, resolved) => !!line.product_id && line.product_id === resolved.productId,
    isEmptyLine: (line) => !line.product_id && !line.description,
    buildLine: (resolved, quantity, lines) => ({
      product_id: resolved.productId,
      description: resolved.name,
      quantity,
      target_price: null,
      sort_order: lines.length,
    }) as LineItem,
    applyToExisting: (_line, quantity) => ({ quantity }) as Partial<LineItem>,
  });

  const addLineItem = useCallback(
    () => setLineItems((prev) => [...prev, emptyLine(prev.length)]),
    [],
  );

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }, []);

  const toggleVendor = (vendorId: string) => {
    setSelectedVendorIds((prev) =>
      prev.includes(vendorId)
        ? prev.filter((v) => v !== vendorId)
        : [...prev, vendorId],
    );
  };

  const estimatedTotal = lineItems.reduce(
    (sum, i) => sum + (i.target_price ?? 0) * (i.quantity ?? 0),
    0,
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validItems = lineItems.filter((item) => item.description);
    if (validItems.length === 0 || selectedVendorIds.length === 0) {
      toast.error("Add at least one item and one supplier");
      return;
    }
    try {
      await updateRFQAsync({
        id,
        rfq: {
          deadline: deadline || null,
          notes: notes || null,
          required_by_date: requiredBy || null,
        },
        items: validItems,
        vendorIds: selectedVendorIds,
      });
      navigate(`/purchases/rfqs/${id}`);
    } catch {
      // toast handled by hook
    }
  };

  if (loading) {
    return <LoadingState />;
  }
  if (error || !record) {
    return (
      <ErrorState
        title="Unable to load RFQ"
        description={error ?? "Not found."}
        onRetry={() => navigate("/purchases/rfqs")}
      />
    );
  }

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="RFQ"
      recordRef={record.rfq_number}
      meta="Draft RFQ — changes replace items and invited suppliers"
      cancelHref={`/purchases/rfqs/${id}`}
      onSubmit={onSubmit}
      isSubmitting={isUpdating}
      submitDisabled={
        selectedVendorIds.length === 0 ||
        !lineItems.some((i) => i.description)
      }
    >
      <FieldGroup label="RFQ header">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Response deadline</Label>
            <Input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Required by</Label>
            <Input
              type="date"
              value={requiredBy}
              onChange={(e) => setRequiredBy(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional context for suppliers…"
            />
          </div>
        </FieldGrid>
      </FieldGroup>

      <FieldGroup label="Line items">
        <EditableLineItemsGrid
          columns={REQUEST_LINE_COLUMNS}
          rows={lineItems}
          toolbar={
            <DocumentLineScanner
              documentLabel="Request for quotation"
              businessId={currentBusiness?.id}
              branchId={currentBranch?.id ?? null}
              onResolved={handleScanResolved}
              onSessionCommit={handleScanSessionCommit}
            />
          }
          onAddRow={addLineItem}
          onRemoveRow={removeLineItem}
          addLabel="Add item"
          disabled={isUpdating}
          renderRow={(item, index, layout) => (
            <RequestLineRow
              key={index}
              index={index}
              item={item}
              flashed={flashIndex === index}
              products={products.filter((p) => p.is_active)}
              layout={layout}
              disabled={isUpdating}
              formatCurrency={formatLineCurrency}
              unitsFor={unitsFor}
              onPatch={patchLineItem}
              onProductSelect={selectProduct}
            />
          )}
          footer={
            <div className="flex justify-end text-xs text-muted-foreground">
              Estimated value:{" "}
              <span className="ml-1 font-medium text-foreground tabular-nums">
                {formatCurrency(estimatedTotal, baseCurrency)}
              </span>
            </div>
          }
        />
      </FieldGroup>

      <FieldGroup label={`Invite suppliers (${selectedVendorIds.length} selected)`}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-72 overflow-y-auto rounded-md border p-3">
          {vendors.length === 0 ? (
            <p className="text-sm text-muted-foreground col-span-full">
              No suppliers found. Add suppliers in Contacts first.
            </p>
          ) : (
            vendors.map((vendor) => (
              <label
                key={vendor.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 cursor-pointer text-sm"
              >
                <Checkbox
                  checked={selectedVendorIds.includes(vendor.id)}
                  onCheckedChange={() => toggleVendor(vendor.id)}
                />
                <span className="truncate">{vendor.name}</span>
              </label>
            ))
          )}
        </div>
      </FieldGroup>

      <FieldGroup label="Additional info">
        <div className="space-y-2">
          <Label>Notes to suppliers</Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Additional information…"
            rows={3}
          />
        </div>
      </FieldGroup>
    </RecordFormShell>
  );
}