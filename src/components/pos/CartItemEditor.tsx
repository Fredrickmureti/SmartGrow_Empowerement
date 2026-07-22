import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState, useEffect } from "react";
import { Plus, Minus, Percent, DollarSign, Trash2 } from "lucide-react";
import { CartItem } from "@/hooks/pos/usePOSCart";
import { usePOSSecuritySettings } from "@/hooks/pos/usePOSSecuritySettings";
import { useManagerOverride } from "@/hooks/pos/useManagerOverride";

import { ManagerOverrideDialog } from "./ManagerOverrideDialog";
import { useCurrency } from "@/hooks/useCurrency";
import { PrintLabelButton } from "@/components/labels/PrintLabelButton";

interface CartItemEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: CartItem | null;
  onUpdate: (updates: {
    quantity?: number;
    unit_price?: number;
    discount_percent?: number;
    notes?: string;
  }) => void;
  onRemove: () => void;
  registerId?: string;
}

export function CartItemEditor({
  open,
  onOpenChange,
  item,
  onUpdate,
  onRemove,
  registerId,
}: CartItemEditorProps) {
  const [quantity, setQuantity] = useState(1);
  const [unitPrice, setUnitPrice] = useState("");
  const [discountPercent, setDiscountPercent] = useState("");
  const [notes, setNotes] = useState("");
  const [showOverrideDialog, setShowOverrideDialog] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<{
    quantity: number;
    unit_price: number;
    discount_percent: number;
    notes?: string;
  } | null>(null);

  const { settings } = usePOSSecuritySettings();
  const { requestOverride, isVerifying } = useManagerOverride();
  const { formatCurrency } = useCurrency();

  useEffect(() => {
    if (item) {
      setQuantity(item.quantity);
      setUnitPrice(item.unit_price.toFixed(2));
      setDiscountPercent(item.discount_value?.toString() || "");
      setNotes("");
    }
  }, [item]);

  if (!item) return null;

  const handleSave = () => {
    const newPrice = parseFloat(unitPrice);
    const priceChanged = newPrice !== item.unit_price;
    
    // Check if price override approval is required
    if (priceChanged && settings.require_manager_pin_for_price_override) {
      setPendingUpdate({
        quantity,
        unit_price: newPrice,
        discount_percent: discountPercent ? parseFloat(discountPercent) : 0,
        notes: notes || undefined,
      });
      setShowOverrideDialog(true);
      return;
    }
    
    onUpdate({
      quantity,
      unit_price: newPrice,
      discount_percent: discountPercent ? parseFloat(discountPercent) : 0,
      notes: notes || undefined,
    });
    onOpenChange(false);
  };

  const handleOverrideApproval = async (pin: string, reason?: string) => {
    await requestOverride({
      action: "manual_price",
      pin,
      registerId: registerId || "",
      originalValue: item.unit_price,
      newValue: parseFloat(unitPrice) || 0,
      reason: reason || `Price override for ${item.name}`,
    });
    
    if (pendingUpdate) {
      onUpdate(pendingUpdate);
      setPendingUpdate(null);
      onOpenChange(false);
    }
  };

  const handleRemove = () => {
    onRemove();
    onOpenChange(false);
  };

  // Calculate preview
  const price = parseFloat(unitPrice) || 0;
  const discount = parseFloat(discountPercent) || 0;
  const subtotal = price * quantity;
  const discountAmount = subtotal * (discount / 100);
  const lineTotal = subtotal - discountAmount;
  const priceChanged = !!item && price > 0 && price !== item.unit_price;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Item</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Item Info */}
          <div className="p-3 bg-muted rounded-lg">
            <h3 className="font-semibold">{item.name}</h3>
            {item.sku && (
              <p className="text-sm text-muted-foreground">SKU: {item.sku}</p>
            )}
          </div>

          {/* Quantity */}
          <div className="space-y-2">
            <Label>Quantity</Label>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-24 text-center"
                min={1}
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => setQuantity(quantity + 1)}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Unit Price */}
          <div className="space-y-2">
            <Label>Unit Price</Label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="number"
                step="0.01"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {/* Line Discount */}
          <div className="space-y-2">
            <Label>Line Discount (%)</Label>
            <div className="relative">
              <Percent className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="number"
                step="0.1"
                min="0"
                max="100"
                placeholder="0"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label>Item Notes</Label>
            <Textarea
              placeholder="Special instructions, modifications..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>

          {/* Price Preview */}
          <div className="space-y-2 p-3 bg-muted rounded-lg text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatCurrency(subtotal)}</span>
            </div>
            {discount > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Discount ({discount}%)</span>
                <span>{formatCurrency(-discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between font-semibold text-base pt-2 border-t">
              <span>Line Total</span>
              <span>{formatCurrency(lineTotal)}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button variant="destructive" onClick={handleRemove}>
              <Trash2 className="h-4 w-4 mr-2" />
              Remove
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleSave}>
              Save Changes
            </Button>
          </div>

          {/* Change-price → new shelf-edge label (Phase 17 step 15).
              Only surfaced when the cashier has actually changed the price,
              so a shelf label is only reprinted when the shelf tag is now
              wrong. Routes through the shared useLabelPrint seam. */}
          {priceChanged && item.product_id ? (
            <PrintLabelButton
              variant="outline"
              size="sm"
              className="w-full"
              label="Print updated shelf label"
              templateKey="shelf_label"
              workflow="shelf_edge"
              product={{
                id: item.product_id,
                name: item.name,
                sku: item.sku ?? null,
                barcode: null,
              }}
              extraVars={{ price: formatCurrency(price) }}
              idempotencyKey={`pos:shelf_label:${item.product_id}:${price}`}
            />
          ) : null}
        </div>
      </DialogContent>

      {/* Manager Override Dialog for Price Changes */}
      <ManagerOverrideDialog
        open={showOverrideDialog}
        onOpenChange={(open) => {
          setShowOverrideDialog(open);
          if (!open) setPendingUpdate(null);
        }}
        action="manual_price"
        originalValue={item.unit_price}
        newValue={parseFloat(unitPrice) || 0}
        onApprove={handleOverrideApproval}
        isVerifying={isVerifying}
      />
    </Dialog>
  );
}
