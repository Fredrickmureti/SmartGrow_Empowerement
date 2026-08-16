/**
 * VendorPriceListFormSheet — right-side DetailSheet for
 * creating/editing a vendor price list entry.
 *
 * Enterprise UX Standardization: retires the inline Dialog on
 * `src/pages/VendorPriceLists.tsx`. Price list entries are
 * lightweight configuration records — the design system permits
 * DetailSheet for that record class (see design-system/records.md).
 */
import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { useSellableUnits } from "@/hooks/useSellableUnits";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
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

interface VendorOption {
  id: string;
  name: string;
}
interface ProductOption {
  id: string;
  name: string;
  is_active?: boolean;
  base_uom_id?: string | null;
}

export interface PriceBreakTierInput {
  min_qty: number;
  unit_price: number;
}

export interface VendorPriceListFormValues {
  vendor_id: string;
  product_id: string;
  unit_price: number;
  currency: string;
  min_order_qty: number;
  /** Orderable step above the minimum. 0 / empty means any quantity. */
  order_increment: number;
  price_break_tiers: PriceBreakTierInput[];
  purchase_uom_id: string | null;
  lead_time_days: number;
  /** 1 = primary source. Lower ranks are preferred. */
  preferred_rank: number;
  is_preferred: boolean;
  valid_from: string;
  valid_until: string;
  notes: string;
  is_active: boolean;
}

const defaults = (baseCurrency: string): VendorPriceListFormValues => ({
  vendor_id: "",
  product_id: "",
  unit_price: 0,
  currency: baseCurrency,
  min_order_qty: 1,
  order_increment: 0,
  price_break_tiers: [],
  purchase_uom_id: null,
  lead_time_days: 0,
  preferred_rank: 10,
  is_preferred: false,
  valid_from: "",
  valid_until: "",
  notes: "",
  is_active: true,
});


interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  initialValues?: Partial<VendorPriceListFormValues>;
  vendors: VendorOption[];
  products: ProductOption[];
  baseCurrency: string;
  /** Currencies the business has enabled. Falls back to the base currency. */
  currencyOptions?: string[];
  isSubmitting?: boolean;
  onSubmit: (values: VendorPriceListFormValues) => void | Promise<void>;
}

export function VendorPriceListFormSheet({
  open,
  onOpenChange,
  mode,
  initialValues,
  vendors,
  products,
  baseCurrency,
  currencyOptions,
  isSubmitting,
  onSubmit,
}: Props) {

  const [values, setValues] = useState<VendorPriceListFormValues>({
    ...defaults(baseCurrency),
    ...initialValues,
  });

  const { unitsForBase } = useSellableUnits();
  const selectedProduct = products.find((p) => p.id === values.product_id);
  const unitOptions = unitsForBase(selectedProduct?.base_uom_id ?? null);
  const currencies = Array.from(
    new Set([...(currencyOptions ?? []), baseCurrency, values.currency].filter(Boolean)),
  ) as string[];

  useEffect(() => {
    if (open) {
      setValues({ ...defaults(baseCurrency), ...initialValues });
    }
  }, [open, initialValues, baseCurrency]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.vendor_id || !values.product_id) return;
    onSubmit(values);
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={mode === "edit" ? "Edit price entry" : "New price entry"}
      description={
        mode === "edit"
          ? "Update vendor pricing details"
          : "Add a vendor's pricing for a product"
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          }
          trailing={
            <Button
              type="submit"
              form="vendor-price-list-form"
              disabled={isSubmitting || !values.vendor_id || !values.product_id}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === "edit" ? "Save changes" : "Add entry"}
            </Button>
          }
        />
      }
    >
      <form
        id="vendor-price-list-form"
        onSubmit={handleSubmit}
        className="space-y-6"
        noValidate
      >
        <FieldGroup label="Vendor & Product">
          <FieldGrid columns={2}>
            <div className="space-y-2">
              <Label>Supplier *</Label>
              <Select
                value={values.vendor_id}
                onValueChange={(v) => setValues({ ...values, vendor_id: v })}
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
              <Label>Product *</Label>
              <Select
                value={values.product_id}
                onValueChange={(v) => setValues({ ...values, product_id: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select product" />
                </SelectTrigger>
                <SelectContent>
                  {products
                    .filter((p) => p.is_active !== false)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </FieldGrid>
        </FieldGroup>

        <FieldGroup label="Pricing & Terms">
          <FieldGrid columns={3}>
            <div className="space-y-2">
              <Label>Unit Price</Label>
              <Input
                type="number"
                step="0.01"
                value={values.unit_price}
                onChange={(e) =>
                  setValues({ ...values, unit_price: parseFloat(e.target.value) || 0 })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Min Order Qty</Label>
              <Input
                type="number"
                value={values.min_order_qty}
                onChange={(e) =>
                  setValues({ ...values, min_order_qty: parseInt(e.target.value) || 1 })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Currency</Label>
              <Select
                value={values.currency || baseCurrency}
                onValueChange={(v) => setValues({ ...values, currency: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={baseCurrency} />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Order increment</Label>
              <Input
                type="number"
                min={0}
                value={values.order_increment}
                onChange={(e) =>
                  setValues({ ...values, order_increment: parseFloat(e.target.value) || 0 })
                }
                placeholder="Any quantity"
              />
            </div>
            <div className="space-y-2">
              <Label>Purchase unit</Label>
              <Select
                value={values.purchase_uom_id ?? "__base"}
                onValueChange={(v) =>
                  setValues({ ...values, purchase_uom_id: v === "__base" ? null : v })
                }
                disabled={!values.product_id || unitOptions.length === 0}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Product base unit" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__base">Product base unit</SelectItem>
                  {unitOptions.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.code} — {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Lead time (calendar days)</Label>
              <Input
                type="number"
                value={values.lead_time_days}
                onChange={(e) =>
                  setValues({ ...values, lead_time_days: parseInt(e.target.value) || 0 })
                }
              />
              <p className="text-xs text-muted-foreground">
                From purchase-order issue to goods available at the receiving location.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Sourcing rank</Label>
              <Input
                type="number"
                min={1}
                value={values.preferred_rank}
                onChange={(e) => {
                  const rank = Math.max(1, parseInt(e.target.value) || 1);
                  setValues({ ...values, preferred_rank: rank, is_preferred: rank <= 1 });
                }}
              />
              <p className="text-xs text-muted-foreground">
                1 is the primary source; higher numbers are fallbacks.
              </p>
            </div>
          </FieldGrid>
        </FieldGroup>

        <FieldGroup label="Price breaks">
          <p className="text-sm text-muted-foreground">
            Quantity tiers in the purchase unit. The highest tier at or below the
            ordered quantity sets the price; below the first tier the unit price
            above applies.
          </p>
          <div className="space-y-2">
            {values.price_break_tiers.map((tier, index) => (
              <div key={index} className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">From qty</Label>
                  <Input
                    type="number"
                    min={0}
                    value={tier.min_qty}
                    onChange={(e) => {
                      const next = [...values.price_break_tiers];
                      next[index] = { ...tier, min_qty: parseFloat(e.target.value) || 0 };
                      setValues({ ...values, price_break_tiers: next });
                    }}
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">Unit price</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    value={tier.unit_price}
                    onChange={(e) => {
                      const next = [...values.price_break_tiers];
                      next[index] = { ...tier, unit_price: parseFloat(e.target.value) || 0 };
                      setValues({ ...values, price_break_tiers: next });
                    }}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove tier ${index + 1}`}
                  onClick={() =>
                    setValues({
                      ...values,
                      price_break_tiers: values.price_break_tiers.filter((_, i) => i !== index),
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setValues({
                  ...values,
                  price_break_tiers: [
                    ...values.price_break_tiers,
                    { min_qty: 0, unit_price: values.unit_price },
                  ],
                })
              }
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add tier
            </Button>
          </div>
        </FieldGroup>


        <FieldGroup label="Validity">
          <FieldGrid columns={2}>
            <div className="space-y-2">
              <Label>Valid From</Label>
              <Input
                type="date"
                value={values.valid_from}
                onChange={(e) => setValues({ ...values, valid_from: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Valid Until</Label>
              <Input
                type="date"
                value={values.valid_until}
                onChange={(e) => setValues({ ...values, valid_until: e.target.value })}
              />
            </div>
          </FieldGrid>

        </FieldGroup>

        <FieldGroup label="Notes">
          <div className="space-y-2">
            <Textarea
              value={values.notes}
              onChange={(e) => setValues({ ...values, notes: e.target.value })}
              placeholder="Optional notes..."
              rows={3}
            />
          </div>
        </FieldGroup>
      </form>
    </DetailSheet>
  );
}