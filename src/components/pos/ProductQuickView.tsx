import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { Plus, Minus, Package, DollarSign, Tag } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";

interface ProductQuickViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: {
    id: string;
    name: string;
    sku?: string;
    selling_price: number;
    cost_price?: number;
    tax_rate?: number;
    stock_quantity?: number;
    track_inventory?: boolean;
    image_url?: string;
    description?: string;
  } | null;
  onAddToCart: (quantity: number, customPrice?: number) => void;
}

export function ProductQuickView({
  open,
  onOpenChange,
  product,
  onAddToCart,
}: ProductQuickViewProps) {
  const [quantity, setQuantity] = useState(1);
  const [customPrice, setCustomPrice] = useState<string>("");
  const [useCustomPrice, setUseCustomPrice] = useState(false);
  const { formatCurrency } = useCurrency();

  if (!product) return null;

  const handleAdd = () => {
    onAddToCart(
      quantity,
      useCustomPrice && customPrice ? parseFloat(customPrice) : undefined
    );
    setQuantity(1);
    setCustomPrice("");
    setUseCustomPrice(false);
    onOpenChange(false);
  };

  const lineTotal = quantity * (useCustomPrice && customPrice ? parseFloat(customPrice) : product.selling_price);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to Cart</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Product Info */}
          <div className="flex gap-4">
            {product.image_url ? (
              <img
                src={product.image_url}
                alt={product.name}
                className="h-28 w-28 sm:h-32 sm:w-32 object-cover rounded-xl shadow-md"
              />
            ) : (
              <div className="h-28 w-28 sm:h-32 sm:w-32 bg-muted rounded-xl flex items-center justify-center text-3xl sm:text-4xl font-bold text-muted-foreground shadow-md">
                {product.name.charAt(0)}
              </div>
            )}
            <div className="flex-1">
              <h3 className="font-semibold">{product.name}</h3>
              {product.sku && (
                <p className="text-sm text-muted-foreground">SKU: {product.sku}</p>
              )}
              <p className="text-lg font-bold text-primary mt-1">
                {formatCurrency(product.selling_price)}
              </p>
              {product.track_inventory && (
                <div className="flex items-center gap-1 mt-1">
                  <Package className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    {product.stock_quantity || 0} in stock
                  </span>
                </div>
              )}
            </div>
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
                className="w-20 text-center"
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

          {/* Custom Price */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="custom-price"
                checked={useCustomPrice}
                onChange={(e) => setUseCustomPrice(e.target.checked)}
                className="rounded"
              />
              <Label htmlFor="custom-price" className="text-sm cursor-pointer">
                Use custom price
              </Label>
            </div>
            {useCustomPrice && (
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="number"
                  step="0.01"
                  placeholder={product.selling_price.toFixed(2)}
                  value={customPrice}
                  onChange={(e) => setCustomPrice(e.target.value)}
                  className="pl-9"
                />
              </div>
            )}
          </div>

          {/* Line Total */}
          <div className="flex justify-between items-center p-3 bg-muted rounded-lg">
            <span className="font-medium">Line Total</span>
            <span className="text-xl font-bold">{formatCurrency(lineTotal)}</span>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleAdd}>
              Add to Cart
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
