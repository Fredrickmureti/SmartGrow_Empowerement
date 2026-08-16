import { forwardRef } from "react";
import { Search, Grid3X3, List, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { POSProduct } from "@/hooks/pos/usePOSProducts";
import type { HappyHour } from "@/hooks/pos/useHappyHour";

export interface ProductDiscoveryPanelProps {
  searchInputRef: React.RefObject<HTMLInputElement>;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  handleSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  viewMode: "grid" | "list";
  setViewMode: (mode: "grid" | "list") => void;
  categories: string[];
  selectedCategory: string | null;
  setSelectedCategory: (cat: string | null) => void;
  filteredProducts: POSProduct[];
  productsLoading: boolean;
  /** Message from a failed canonical product read, if any. */
  productsErrorMessage?: string | null;
  productsLoadedCount: number;
  productsTotalCount: number | null;
  productsHasMore: boolean;
  isFetchingMoreProducts: boolean;
  fetchMoreProducts: () => void;
  branchOnHand: Map<string, number>;
  handleProductClick: (product: POSProduct) => void;
  getDiscountedPrice: (
    productId: string,
    basePrice: number,
  ) => { price: number; happyHour: HappyHour | null; savings: number };
  formatCurrency: (value: number) => string;
}

/**
 * ProductDiscoveryPanel — sale-phase product search, category filter and
 * grid/list rendering. Pure prop-driven — no hooks, no context reads.
 * Extracted from POSTerminal.tsx (Step 6.2a).
 */
export function ProductDiscoveryPanel({
  searchInputRef,
  searchQuery,
  setSearchQuery,
  handleSearchKeyDown,
  viewMode,
  setViewMode,
  categories,
  selectedCategory,
  setSelectedCategory,
  filteredProducts,
  productsLoading,
  productsErrorMessage,
  productsLoadedCount,
  productsTotalCount,
  productsHasMore,
  isFetchingMoreProducts,
  fetchMoreProducts,
  branchOnHand,
  handleProductClick,
  getDiscountedPrice,
  formatCurrency,
}: ProductDiscoveryPanelProps) {
  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Search & Categories */}
      <div className="p-2 sm:p-4 border-b space-y-2 sm:space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="pos-search"
              ref={searchInputRef}
              placeholder="Search or scan…  (F2 to focus, n*<barcode> for qty)"
              className="pl-10 text-sm sm:text-base"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
          <div className="flex border rounded-md">
            <Button
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="icon"
              className="h-9 w-9 sm:h-10 sm:w-10 rounded-r-none"
              onClick={() => setViewMode("grid")}
            >
              <Grid3X3 className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="icon"
              className="h-9 w-9 sm:h-10 sm:w-10 rounded-l-none"
              onClick={() => setViewMode("list")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Category Pills */}
        <div className="flex gap-1.5 sm:gap-2 overflow-x-auto pb-1 scrollbar-hide">
          <Button
            variant={selectedCategory === null ? "default" : "outline"}
            size="sm"
            className="text-xs sm:text-sm whitespace-nowrap"
            onClick={() => setSelectedCategory(null)}
          >
            All
          </Button>
          {categories.map((cat) => (
            <Button
              key={cat}
              variant={selectedCategory === cat ? "default" : "outline"}
              size="sm"
              className="text-xs sm:text-sm whitespace-nowrap"
              onClick={() => setSelectedCategory(cat)}
            >
              {cat}
            </Button>
          ))}
        </div>
      </div>

      {/* Product Grid/List - Responsive */}
      <ScrollArea className="flex-1 pb-16 lg:pb-0">
        <div
          className={cn(
            "p-2 sm:p-4",
            viewMode === "grid"
              ? "grid grid-cols-2 xs:grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2 sm:gap-3"
              : "space-y-2",
          )}
        >
          {productsLoading ? (
            Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "animate-pulse bg-muted rounded-lg",
                  viewMode === "grid" ? "aspect-square" : "h-16",
                )}
              />
            ))
          ) : productsErrorMessage ? (
            <div className="col-span-full text-center py-12 space-y-1">
              <p className="text-sm font-medium text-destructive">
                Product catalogue could not be loaded
              </p>
              <p className="text-xs text-muted-foreground">{productsErrorMessage}</p>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="col-span-full text-center py-12 text-muted-foreground">
              No products found
            </div>
          ) : viewMode === "grid" ? (
            filteredProducts.map((product) => (
              <button
                key={product.id}
                onClick={() => handleProductClick(product)}
                className="aspect-square rounded-lg border bg-card p-2 sm:p-3 flex flex-col items-center justify-center text-center hover:border-primary hover:shadow-md transition-all active:scale-95"
              >
                {product.image_url ? (
                  <img
                    src={product.image_url}
                    alt={product.name}
                    className="h-16 w-16 sm:h-20 sm:w-20 md:h-24 md:w-24 object-cover rounded-lg mb-2"
                  />
                ) : (
                  <div className="h-16 w-16 sm:h-20 sm:w-20 md:h-24 md:w-24 bg-muted rounded-lg mb-2 flex items-center justify-center text-xl sm:text-2xl md:text-3xl font-bold text-muted-foreground">
                    {product.name.charAt(0)}
                  </div>
                )}
                <span className="text-xs sm:text-sm font-medium line-clamp-2 leading-tight">
                  {product.name}
                </span>
                {(() => {
                  const hh = getDiscountedPrice(product.id, product.selling_price);
                  if (hh.happyHour) {
                    return (
                      <div className="flex flex-col items-center mt-0.5">
                        <span className="text-[10px] line-through text-muted-foreground">
                          {formatCurrency(product.selling_price)}
                        </span>
                        <span className="text-xs sm:text-sm text-primary font-semibold">
                          {formatCurrency(hh.price)}
                        </span>
                        <Badge variant="secondary" className="text-[9px] px-1 mt-0.5">
                          <Sparkles className="h-2.5 w-2.5 mr-0.5" />
                          {hh.happyHour.name}
                        </Badge>
                      </div>
                    );
                  }
                  return (
                    <span className="text-xs sm:text-sm text-primary font-semibold mt-0.5 sm:mt-1">
                      {formatCurrency(product.selling_price)}
                    </span>
                  );
                })()}
                {product.track_inventory &&
                  (branchOnHand.get(product.id) ?? 0) <= (product.reorder_level || 0) && (
                    <Badge variant="destructive" className="text-[10px] sm:text-xs mt-0.5 sm:mt-1 px-1">
                      Low
                    </Badge>
                  )}
              </button>
            ))
          ) : (
            filteredProducts.map((product) => (
              <button
                key={product.id}
                onClick={() => handleProductClick(product)}
                className="w-full flex items-center gap-4 p-3 rounded-lg border bg-card hover:border-primary hover:shadow-md transition-all"
              >
                {product.image_url ? (
                  <img
                    src={product.image_url}
                    alt={product.name}
                    className="h-16 w-16 sm:h-20 sm:w-20 object-cover rounded-lg"
                  />
                ) : (
                  <div className="h-16 w-16 sm:h-20 sm:w-20 bg-muted rounded-lg flex items-center justify-center text-xl sm:text-2xl font-bold text-muted-foreground">
                    {product.name.charAt(0)}
                  </div>
                )}
                <div className="flex-1 text-left">
                  <p className="font-medium text-xs sm:text-sm md:text-base">{product.name}</p>
                  <p className="text-xs text-muted-foreground">{product.sku}</p>
                </div>
                <span className="text-sm sm:text-base md:text-lg font-semibold text-primary whitespace-nowrap">
                  {formatCurrency(product.selling_price)}
                </span>
              </button>
            ))
          )}
        </div>
        {!productsLoading && filteredProducts.length > 0 && (
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {productsLoadedCount.toLocaleString()}
              {productsTotalCount != null ? ` of ${productsTotalCount.toLocaleString()}` : ""} products
            </span>
            {productsHasMore && (
              <button
                type="button"
                onClick={() => fetchMoreProducts()}
                disabled={isFetchingMoreProducts}
                className="text-primary hover:underline disabled:opacity-50"
              >
                {isFetchingMoreProducts ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}