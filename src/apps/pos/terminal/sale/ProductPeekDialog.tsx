/**
 * ProductPeekDialog — quick product lookup without leaving the sale.
 *
 * Cashiers can peek at stock, SKU, barcode(s), and price for a product
 * by typing / scanning without adding to cart. Complements the search
 * field on the discovery panel: search adds items on Enter; peek is a
 * read-only inspector.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Info, Search, PackagePlus, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { usePOSProducts } from "@/hooks/pos/usePOSProducts";

interface PeekProduct {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  description: string | null;
  price: number | null;
  image_url: string | null;
  track_inventory: boolean | null;
}

interface ProductPeekDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registerId: string;
  /** Product IDs currently in the cart — shown by default when the search
   *  field is empty so the cashier can peek their active basket. */
  cartProductIds?: string[];
  onAddToCart?: (productId: string) => void;
}

export function ProductPeekDialog({
  open,
  onOpenChange,
  registerId,
  cartProductIds,
  onAddToCart,
}: ProductPeekDialogProps) {
  const { formatCurrency } = useCurrency();
  // Canonical product read seam — peek never queries the products table.
  const { products: catalog, isLoading: catalogLoading } = usePOSProducts();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PeekProduct[]>([]);
  const [selected, setSelected] = useState<PeekProduct | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStock, setLoadingStock] = useState(false);

  // Reset when dialog closes.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSelected(null);
      setAvailable(null);
    }
  }, [open]);

  // Default listing: when the search field is empty, show whatever the
  // cashier already has in the cart so peek doubles as a "what am I
  // ringing up?" panel. Typing kicks over to a catalog search.
  const cartIdsKey = (cartProductIds ?? []).join(",");
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length >= 2) return;
    if (!cartProductIds || cartProductIds.length === 0) {
      setResults([]);
      return;
    }
    setLoading(catalogLoading);
    const ids = new Set(cartProductIds);
    setResults(
      catalog
        .filter((p) => ids.has(p.id))
        .map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          barcode: null,
          description: p.description,
          price: p.selling_price,
          image_url: p.image_url,
          track_inventory: p.track_inventory,
        })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, cartIdsKey, catalog, catalogLoading]);

  // Debounced product search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) return;
    const t = setTimeout(() => {
      setLoading(catalogLoading);
      const needle = q.toLowerCase();
      setResults(
        catalog
          .filter(
            (p) =>
              p.name.toLowerCase().includes(needle) ||
              (p.sku ?? "").toLowerCase().includes(needle),
          )
          .slice(0, 15)
          .map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            barcode: null,
            description: p.description,
            price: p.selling_price,
            image_url: p.image_url,
            track_inventory: p.track_inventory,
          })),
      );
    }, 220);
    return () => clearTimeout(t);
  }, [query, open, catalog, catalogLoading]);

  // Live stock for selected product.
  useEffect(() => {
    if (!selected) {
      setAvailable(null);
      return;
    }
    if (!selected.track_inventory) {
      setAvailable(null);
      return;
    }
    let cancelled = false;
    setLoadingStock(true);
    (async () => {
      const { data } = await supabase.rpc(
        "get_available_pos_stock_for_register" as never,
        {
          p_product_id: selected.id,
          p_register_id: registerId,
          p_exclude_self: true,
        } as never,
      );
      if (!cancelled) {
        setAvailable(Number(data ?? 0));
        setLoadingStock(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, registerId]);

  const availabilityChip = useMemo(() => {
    if (!selected) return null;
    if (!selected.track_inventory)
      return <Badge variant="secondary">Not stock-tracked</Badge>;
    if (loadingStock)
      return (
        <Badge variant="secondary">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" /> checking…
        </Badge>
      );
    if (available == null) return null;
    if (available <= 0)
      return <Badge variant="destructive">Out of stock</Badge>;
    if (available < 5) return <Badge>Low ({available})</Badge>;
    return <Badge variant="secondary">Available: {available}</Badge>;
  }, [selected, available, loadingStock]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info className="h-5 w-5" />
            Product info
          </DialogTitle>
          <DialogDescription>
            Search by name, SKU, or barcode. Peek details without adding to
            the cart.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Search or scan…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-h-[220px]">
          <ScrollArea className="h-[260px] rounded-md border">
            <div className="p-1">
              {loading && (
                <div className="p-3 text-sm text-muted-foreground">
                  Searching…
                </div>
              )}
              {!loading && results.length === 0 && query.trim().length >= 2 && (
                <div className="p-3 text-sm text-muted-foreground">
                  No products match "{query}".
                </div>
              )}
              {!loading && query.trim().length < 2 && results.length === 0 && (
                <div className="p-3 text-sm text-muted-foreground">
                  {cartProductIds && cartProductIds.length > 0
                    ? "Loading cart products…"
                    : "Cart is empty — type a name, SKU, or barcode to look up any product."}
                </div>
              )}
              {!loading && query.trim().length < 2 && results.length > 0 && (
                <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  In cart
                </div>
              )}
              {results.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted ${
                    selected?.id === p.id ? "bg-muted" : ""
                  }`}
                  onClick={() => setSelected(p)}
                >
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.sku ?? "—"} · {p.barcode ?? "no barcode"}
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>

          <div className="rounded-md border p-3 text-sm">
            {!selected ? (
              <div className="text-muted-foreground">
                Select a product to view details.
              </div>
            ) : (
              <div className="space-y-2">
                <div>
                  <div className="text-base font-semibold">{selected.name}</div>
                  {selected.description && (
                    <div className="text-xs text-muted-foreground line-clamp-2">
                      {selected.description}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">{availabilityChip}</div>
                <dl className="grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">SKU</dt>
                  <dd className="col-span-2 font-mono">
                    {selected.sku ?? "—"}
                  </dd>
                  <dt className="text-muted-foreground">Barcode</dt>
                  <dd className="col-span-2 font-mono">
                    {selected.barcode ?? "—"}
                  </dd>
                  <dt className="text-muted-foreground">Price</dt>
                  <dd className="col-span-2 font-medium">
                    {selected.price != null
                      ? formatCurrency(Number(selected.price))
                      : "—"}
                  </dd>
                </dl>
                {onAddToCart && (
                  <Button
                    size="sm"
                    className="w-full mt-2"
                    onClick={() => {
                      onAddToCart(selected.id);
                      onOpenChange(false);
                    }}
                    disabled={
                      selected.track_inventory === true &&
                      available != null &&
                      available <= 0
                    }
                  >
                    <PackagePlus className="mr-1 h-4 w-4" />
                    Add to cart
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
