/**
 * DeliveryNoteCreatePage — `/sales/delivery-notes/new`.
 *
 * Phase-3 route replacement for the retired `CreateDeliveryNoteDialog`.
 * Hosts the same form body on top of `RecordFormShell`.
 *
 * Deep-link params:
 *   ?contact_id=<uuid>   pre-fill customer
 */
import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useDeliveryNotes } from "@/hooks/useDeliveryNotes";
import { useContacts } from "@/hooks/useContacts";
import { useBranchScopedProducts } from "@/hooks/useBranchScopedProducts";
import { OutboundLineTracking } from "@/components/inventory/OutboundLineTracking";
import {
  lotNumberFromAllocations,
  lotAllocationsJson,
  serialNumberFromRows,
} from "@/components/inventory/outboundLineTrackingUtils";
import type { LotAllocationPayload } from "@/components/inventory/LotPickerPopover";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { validateLineItems } from "@/lib/validation/lineItems";
import { StockLineStatus } from "@/components/inventory/StockAvailabilityIndicator";
import {
  OversellConfirmation,
  useSalesLineAvailability,
} from "@/features/sales/availability";
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import { DeliveryNoteLineRow, DELIVERY_LINE_COLUMNS } from "@/components/documents/lines/DeliveryNoteLineRow";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { DocumentLineScanner } from "@/components/documents/lines/DocumentLineScanner";
import {
  useDocumentLineScan,
  scanUnitPrice,
  scanTaxRate,
} from "@/features/sales/scan-session/useDocumentLineScan";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { FieldGrid, FieldCell, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { ShipToPicker } from "@/components/addresses/ShipToPicker";

const formSchema = z.object({
  contact_id: z.string().min(1, "Customer is required"),
  delivery_date: z.string(),
  // Structured link to the customer's saved address (null = custom address).
  ship_to_contact_id: z.string().nullable().optional(),
  // Rendered snapshot printed on the document.
  shipping_address: z.string().optional(),
  driver_name: z.string().optional(),
  vehicle_number: z.string().optional(),
  notes: z.string().optional(),
  auto_invoice_on_complete: z.boolean().default(true),
});

interface LineItem {
  product_id: string | null;
  description: string;
  quantity_ordered: number;
  quantity_delivered: number;
  unit_price: number;
  tax_rate: number;
  discount_percent: number;
  packaging_id?: string | null;
  display_uom_id?: string | null;
  display_quantity?: number | null;
  // Phase A.4 — picker output persisted to delivery_note_items.
  lot_number?: string | null;
  serial_number?: string | null;
  lot_allocations?: LotAllocationPayload[] | null;
}

export default function DeliveryNoteCreatePage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Handheld list pages deep-link here with `openScanSession` so the
  // camera sheet opens immediately (see ScanToDocumentButton).
  const openScanSessionOnMount =
    ((location.state as { openScanSession?: boolean } | null)?.openScanSession) === true;
  const [searchParams] = useSearchParams();
  const prefillContactId = searchParams.get("contact_id") ?? undefined;

  const { createDeliveryNote } = useDeliveryNotes();
  const { contacts } = useContacts();
  const { products, branchScopeLabel } = useBranchScopedProducts();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { product_id: null, description: "", quantity_ordered: 1, quantity_delivered: 1, unit_price: 0, tax_rate: 0, discount_percent: 0 },
  ]);

  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both");

  /**
   * Strictest surface in Sales: goods physically leave the building, so the
   * check runs against `quantity_delivered` (what actually ships), not the
   * ordered quantity, and a shortfall must be explicitly acknowledged.
   */
  const availability = useSalesLineAvailability({
    kind: "delivery_note",
    lines: lineItems.map((l) => ({
      product_id: l.product_id,
      quantity: l.quantity_delivered,
    })),
    products,
    scopeLabel: branchScopeLabel,
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      contact_id: prefillContactId || "",
      delivery_date: new Date().toISOString().split("T")[0],
      ship_to_contact_id: null,
      shipping_address: "",
      driver_name: "",
      vehicle_number: "",
      notes: "",
      auto_invoice_on_complete: true,
    },
  });

  const watchedContactId = form.watch("contact_id");

  useEffect(() => {
    if (prefillContactId) form.setValue("contact_id", prefillContactId);
  }, [prefillContactId, form]);

  // Scan-to-line parity — a delivery note counts physical units, so unlike the
  // priced author-time documents a repeat scan DOES bump the delivered
  // quantity, and it is capped at what the line says was ordered (a delivery
  // note must never invent stock movements the order did not authorise).
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { handleScanResolved, handleScanSessionCommit, flashIndex } = useDocumentLineScan<LineItem>({
    setLines: setLineItems,
    incrementOnSingleScan: true,
    matchLine: (line, resolved) => !!line.product_id && line.product_id === resolved.productId,
    buildLine: (resolved, quantity) => ({
      product_id: resolved.productId,
      description: resolved.name,
      quantity_ordered: quantity,
      quantity_delivered: quantity,
      unit_price: scanUnitPrice(resolved),
      tax_rate: scanTaxRate(resolved),
      discount_percent: 0,
    }),
    isEmptyLine: (line) =>
      !line.product_id && !line.description && (line.quantity_delivered ?? 0) <= 1 && (line.unit_price ?? 0) === 0,
    applyToExisting: (line, quantity, _resolved, source) => {
      const target = source === "session" ? quantity : (line.quantity_delivered ?? 0) + quantity;
      const ordered = line.quantity_ordered ?? 0;
      // Over-delivery is refused, not silently clamped — the operator needs to
      // know the physical count exceeds the authorised quantity.
      if (ordered > 0 && target > ordered) return null;
      return { quantity_delivered: target };
    },
    rejectMessage: (line, resolved) =>
      `${resolved.name}: only ${line.quantity_ordered} ordered on this delivery note`,
  });

  const addLineItem = () => {
    setLineItems([...lineItems, { product_id: null, description: "", quantity_ordered: 1, quantity_delivered: 1, unit_price: 0, tax_rate: 0, discount_percent: 0 }]);
  };

  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) setLineItems(lineItems.filter((_, i) => i !== index));
  };

  /** Applies a partial line update, deriving defaults when the product changes. */
  const patchLineItem = useCallback(
    (index: number, patch: Partial<LineItem>) => {
      setLineItems((prev) =>
        prev.map((it, i) => {
          if (i !== index) return it;
          const next = { ...it, ...patch };
          if (patch.product_id) {
            const product = products.find((p) => p.id === patch.product_id);
            if (product) {
              next.description = product.name;
              if (!next.unit_price) next.unit_price = Number(product.unit_price) || 0;
              if (!next.tax_rate) next.tax_rate = Number(product.tax_rate) || 0;
            }
          }
          return next;
        }),
      );
    },
    [products],
  );

  /**
   * Delivered-quantity edits. Ordered follows delivered only while the two
   * were still in step, so an explicit short-delivery is never overwritten.
   */
  const applyDeliveredPatch = useCallback(
    (index: number, patch: {
      quantity?: number;
      packaging_id?: string | null;
      display_quantity?: number | null;
      display_uom_id?: string | null;
    }) => {
      setLineItems((prev) =>
        prev.map((it, i) => {
          if (i !== index) return it;
          const next: LineItem = { ...it };
          if (patch.quantity !== undefined) {
            const inStep = it.quantity_ordered === it.quantity_delivered;
            next.quantity_delivered = patch.quantity;
            if (inStep) next.quantity_ordered = patch.quantity;
          }
          if (patch.packaging_id !== undefined) next.packaging_id = patch.packaging_id;
          if (patch.display_quantity !== undefined) next.display_quantity = patch.display_quantity;
          if (patch.display_uom_id !== undefined) next.display_uom_id = patch.display_uom_id;
          return next;
        }),
      );
    },
    [],
  );

  const formatLineCurrency = useCallback((n: number) => n.toFixed(2), []);

  const computeLine = (it: LineItem) => {
    const gross = (it.quantity_delivered || 0) * (it.unit_price || 0);
    const afterDiscount = gross * (1 - (it.discount_percent || 0) / 100);
    const tax = afterDiscount * ((it.tax_rate || 0) / 100);
    return { subtotal: afterDiscount, tax, total: afterDiscount + tax };
  };

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    const validation = validateLineItems(lineItems, { quantityKey: "quantity_ordered" });
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }
    const validatedLines = validation.valid;

    const stockBlock = availability.blockingReason();
    if (stockBlock) {
      toast.error(stockBlock);
      return;
    }

    if (values.auto_invoice_on_complete) {
      const missing = validatedLines.find((l) => !l.unit_price || l.unit_price <= 0);
      if (missing) {
        toast.error("Every line needs a unit price when 'Bill on confirmation' is on. Turn it off for non-billable deliveries (samples, internal transfers).");
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const items = validatedLines.map((item) => {
        const c = computeLine(item as LineItem);
        return {
          product_id: item.product_id,
          description: item.description,
          quantity_ordered: item.quantity_ordered,
          quantity_delivered: item.quantity_delivered,
          unit_price: item.unit_price || null,
          tax_rate: item.tax_rate || 0,
          tax_amount: c.tax,
          discount_percent: item.discount_percent || 0,
          line_total: c.total,
          packaging_id: item.packaging_id ?? null,
          display_uom_id: item.display_uom_id ?? null,
          display_quantity: item.display_quantity ?? null,
        };
      });

      const created = await createDeliveryNote(
        {
          ...values,
          status: "pending",
        } as any,
        items as any,
      );
      if (created?.id) {
        navigate(`/sales/delivery-notes/${created.id}`);
      } else {
        navigate("/sales/delivery-notes");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Delivery Note"
      meta={
        <>
          Create a delivery note for goods being shipped · Stock shown for:{" "}
          <span className="font-medium text-foreground">{branchScopeLabel}</span>
        </>
      }
      cancelHref="/sales/delivery-notes"
      onSubmit={form.handleSubmit(onSubmit)}
      isSubmitting={isSubmitting}
      submitDisabled={!watchedContactId}
      submitLabel="Create Delivery Note"
    >
      <Form {...form}>
        <div className="space-y-6 min-w-0">
          <FieldGroup label="Delivery Details">
            <FieldGrid columns={2}>
              <FormField
                control={form.control}
                name="contact_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Customer *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select customer" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {customers.map((contact) => (
                          <SelectItem key={contact.id} value={contact.id}>{contact.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="delivery_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Delivery Date</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FieldCell span={2}>
                <ShipToPicker
                  contactId={watchedContactId || null}
                  value={{
                    shipToContactId: form.watch("ship_to_contact_id") ?? null,
                    shippingAddress: form.watch("shipping_address") ?? "",
                  }}
                  onChange={(next) => {
                    form.setValue("ship_to_contact_id", next.shipToContactId, {
                      shouldDirty: true,
                    });
                    form.setValue("shipping_address", next.shippingAddress, {
                      shouldDirty: true,
                    });
                  }}
                />
              </FieldCell>
              <FormField
                control={form.control}
                name="driver_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Driver Name</FormLabel>
                    <FormControl><Input {...field} placeholder="Driver name" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="vehicle_number"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vehicle Number</FormLabel>
                    <FormControl><Input {...field} placeholder="Vehicle registration" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGrid>
          </FieldGroup>

          <FieldGroup label="Items to Deliver">
            <EditableLineItemsGrid
              columns={DELIVERY_LINE_COLUMNS}
              rows={lineItems}
              toolbar={
                <DocumentLineScanner
                  documentLabel="Delivery note"
                  mode="verify"
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
                <DeliveryNoteLineRow
                  index={index}
                  item={item}
                  flashed={flashIndex === index}
                  products={products}
                  layout={layout}
                  lineTotal={computeLine(item).total}
                  formatCurrency={formatLineCurrency}
                  onPatch={patchLineItem}
                  onDeliveredChange={applyDeliveredPatch}
                  extra={
                    <>
                    {availability.evals[index] && (
                      <StockLineStatus
                        trackInventory={availability.evals[index]!.product.track_inventory ?? undefined}
                        productType={availability.evals[index]!.product.type ?? undefined}
                        onHand={
                          availability.evals[index]!.product.available ??
                          availability.evals[index]!.product.stock_quantity ??
                          undefined
                        }
                        reorderLevel={availability.evals[index]!.product.reorder_level ?? undefined}
                        requestedQty={item.quantity_delivered}
                      />
                    )}
                    <OutboundLineTracking
                      productId={item.product_id ?? null}
                      quantity={item.quantity_delivered}
                      onLotChange={(allocs) =>
                        patchLineItem(index, {
                          lot_number: lotNumberFromAllocations(allocs),
                          lot_allocations: lotAllocationsJson(allocs),
                        } as any)
                      }
                      onSerialChange={(_ids, rows) =>
                        patchLineItem(index, {
                          serial_number: serialNumberFromRows(rows),
                        } as any)
                      }
                    />
                    </>
                  }
                />
              )}
            />

            <OversellConfirmation
              kind="delivery_note"
              availability={availability}
              disabled={isSubmitting}
            />
          </FieldGroup>

          <FieldGroup label="Additional Info">
            <FormField
              control={form.control}
              name="auto_invoice_on_complete"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start gap-3 rounded-md border p-3">
                  <FormControl>
                    <input
                      type="checkbox"
                      checked={field.value}
                      onChange={(e) => field.onChange(e.target.checked)}
                      className="mt-1 h-4 w-4"
                    />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>Bill on confirmation</FormLabel>
                    <p className="text-xs text-muted-foreground">
                      When the delivery is marked delivered, a draft invoice for these lines is created automatically in the same transaction. Turn off for samples or internal transfers.
                    </p>
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl><Textarea {...field} placeholder="Delivery instructions or notes..." /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </FieldGroup>
        </div>
      </Form>
    </RecordFormShell>
  );
}
