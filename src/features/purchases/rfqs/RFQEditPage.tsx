// @ts-nocheck
/**
 * RFQEditPage — `/purchases/rfqs/:id/edit`.
 *
 * Only draft RFQs are editable (the underlying updateRFQ mutation
 * enforces this at the persistence layer; the UI redirects non-drafts
 * to the record page so the user is never stuck on a form they can't
 * save).
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { ErrorState, LoadingState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NumericInput } from "@/components/ui/numeric-input";
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
import { useCurrency } from "@/hooks/useCurrency";
import { useRFQRecord } from "./useRFQRecord";

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
  const { formatCurrency, baseCurrency } = useCurrency();

  const [deadline, setDeadline] = useState("");
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
    setNotes(record.notes ?? "");
    setSelectedVendorIds(
      (record.vendors ?? []).map((v: any) => v.vendor_id).filter(Boolean),
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
            target_price: i.target_price ?? null,
            sort_order: idx,
          }))
        : [emptyLine(0)],
    );
    setHydrated(true);
  }, [record, hydrated, id, navigate]);

  const vendors = contacts.filter(
    (c) => (c.type === "supplier" || c.type === "both") && c.is_active,
  );

  const updateLineItem = (index: number, field: string, value: any) => {
    const updated = [...lineItems];
    updated[index] = { ...updated[index], [field]: value };
    if (field === "product_id" && value) {
      const product = products.find((p) => p.id === value);
      if (product) {
        updated[index].description = product.name;
        updated[index].target_price =
          product.cost_price || product.unit_price || null;
      }
    }
    setLineItems(updated);
  };

  const addLineItem = () =>
    setLineItems((prev) => [...prev, emptyLine(prev.length)]);

  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) setLineItems(lineItems.filter((_, i) => i !== index));
  };

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
        rfq: { deadline: deadline || null, notes: notes || null },
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
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">
            Estimated value:{" "}
            <span className="font-medium text-foreground tabular-nums">
              {formatCurrency(estimatedTotal, baseCurrency)}
            </span>
          </span>
          <Button type="button" variant="outline" size="sm" onClick={addLineItem}>
            <Plus className="mr-1 h-3 w-3" /> Add item
          </Button>
        </div>
        <div className="space-y-3">
          {lineItems.map((item, index) => (
            <div
              key={index}
              className="border rounded-lg p-3 space-y-3 sm:border-0 sm:p-0 sm:space-y-0 sm:grid sm:grid-cols-12 sm:gap-2 sm:items-end"
            >
              <div className="sm:col-span-5">
                <Label className="text-xs text-muted-foreground sm:hidden">Product</Label>
                <Select
                  value={item.product_id || ""}
                  onValueChange={(v) => updateLineItem(index, "product_id", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select product" />
                  </SelectTrigger>
                  <SelectContent>
                    {products.filter((p) => p.is_active).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-3">
                <Label className="text-xs text-muted-foreground sm:hidden">Description</Label>
                <Input
                  placeholder="Description"
                  value={item.description}
                  onChange={(e) => updateLineItem(index, "description", e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:contents">
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground sm:hidden">Qty</Label>
                  <NumericInput
                    placeholder="Qty"
                    value={item.quantity}
                    onValueChange={(v) => updateLineItem(index, "quantity", v ?? 0)}
                  />
                </div>
                <div className="sm:col-span-1">
                  <Label className="text-xs text-muted-foreground sm:hidden">Target</Label>
                  <NumericInput
                    placeholder="Target"
                    value={item.target_price ?? null}
                    onValueChange={(v) => updateLineItem(index, "target_price", v ?? null)}
                  />
                </div>
              </div>
              <div className="sm:col-span-1 flex justify-end">
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