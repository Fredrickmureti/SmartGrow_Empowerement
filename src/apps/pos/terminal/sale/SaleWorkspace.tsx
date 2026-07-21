import { useEffect, useState, type RefObject, type KeyboardEvent } from "react";
import { User, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeldOrdersBar } from "@/components/pos/HeldOrdersBar";
import { ScanRecoveryBanner } from "@/components/pos/ScanRecoveryBanner";
import { ProductDiscoveryPanel } from "@/apps/pos/terminal/sale/components/ProductDiscoveryPanel";
import { BasketPanel } from "@/apps/pos/terminal/sale/components/BasketPanel";
import { TransactionSummaryRail } from "@/apps/pos/terminal/sale/components/TransactionSummaryRail";
import { ProductPeekDialog } from "@/apps/pos/terminal/sale/ProductPeekDialog";
import {
  SaleActionBar,
  type SaleActionBarCallbacks,
} from "@/apps/pos/terminal/sale/components/SaleActionBar";
import type { usePOSCartAdapter } from "@/hooks/pos/usePOSCartAdapter";
import type { usePOSSound } from "@/hooks/pos/usePOSSound";
import type { POSProduct } from "@/hooks/pos/usePOSProducts";
import type { HappyHour } from "@/hooks/pos/useHappyHour";

type Cart = ReturnType<typeof usePOSCartAdapter>;
type Sound = ReturnType<typeof usePOSSound>;

type UnknownScan = { code: string; reason: string } | null;
type AppliedPromotionLine = { promotion: { name: string }; discountAmount: number };

export interface SaleWorkspaceProps {
  // Data
  cart: Cart;
  sound: Sound;
  registerId: string | null;
  activeShiftId: string | null;
  tableSessionId: string | null;
  isTableSession: boolean;
  canHold: boolean;
  heldCount: number;
  appliedPromotions: AppliedPromotionLine[];
  unknownScan: UnknownScan;

  // Product discovery
  searchInputRef: RefObject<HTMLInputElement>;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  handleSearchKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  viewMode: "grid" | "list";
  setViewMode: (mode: "grid" | "list") => void;
  categories: string[];
  selectedCategory: string | null;
  setSelectedCategory: (cat: string | null) => void;
  filteredProducts: POSProduct[];
  productsLoading: boolean;
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

  // Scan recovery
  onScanRecoverySearch: (code: string) => void;
  onScanRecoveryCreateProduct: (code: string) => void;
  onScanRecoveryDismiss: () => void;

  // Action-bar semantic callbacks
  saleActionBarCallbacks: SaleActionBarCallbacks;

  // Customer picker
  onOpenCustomer: () => void;
}

/**
 * SaleWorkspace — desktop sale-phase render tree.
 *
 * Hoisted out of `POSTerminal.tsx` (Step 6.2c). Currently prop-driven so it
 * can be mounted from either the legacy monolith or the future `/sale`
 * route (Step 6.2d) without semantic drift. Once route rewire lands, this
 * component will consume `useCart()`, `useTerminalContext()`, and the
 * shift/register context directly — the prop surface is a transitional
 * contract, not a permanent public API.
 *
 * Mobile drawer intentionally still lives in `POSTerminal.tsx`; it will be
 * folded into this workspace in 6.2c-follow-up alongside a `variant`-aware
 * `SaleActionBar` so the two action grids don't diverge.
 */
export function SaleWorkspace({
  cart,
  sound,
  registerId,
  activeShiftId,
  tableSessionId,
  isTableSession,
  canHold,
  heldCount,
  appliedPromotions,
  unknownScan,
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
  productsLoadedCount,
  productsTotalCount,
  productsHasMore,
  isFetchingMoreProducts,
  fetchMoreProducts,
  branchOnHand,
  handleProductClick,
  getDiscountedPrice,
  formatCurrency,
  onScanRecoverySearch,
  onScanRecoveryCreateProduct,
  onScanRecoveryDismiss,
  saleActionBarCallbacks,
  onOpenCustomer,
}: SaleWorkspaceProps) {
  // Silence tableSessionId unused warning — reserved for future
  // workspace-owned confirms during mobile drawer consolidation.
  void tableSessionId;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left Panel - Products */}
      <ProductDiscoveryPanel
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        handleSearchKeyDown={handleSearchKeyDown}
        viewMode={viewMode}
        setViewMode={setViewMode}
        categories={categories}
        selectedCategory={selectedCategory}
        setSelectedCategory={setSelectedCategory}
        filteredProducts={filteredProducts}
        productsLoading={productsLoading}
        productsLoadedCount={productsLoadedCount}
        productsTotalCount={productsTotalCount}
        productsHasMore={productsHasMore}
        isFetchingMoreProducts={isFetchingMoreProducts}
        fetchMoreProducts={fetchMoreProducts}
        branchOnHand={branchOnHand}
        handleProductClick={handleProductClick}
        getDiscountedPrice={getDiscountedPrice}
        formatCurrency={formatCurrency}
      />

      {/* Right Panel - Cart (Desktop) */}
      <div className="hidden lg:flex w-80 xl:w-96 flex-col bg-card border-l">
        <ScanRecoveryBanner
          code={unknownScan?.code ?? null}
          reason={unknownScan?.reason}
          onSearch={onScanRecoverySearch}
          onCreateProduct={onScanRecoveryCreateProduct}
          onDismiss={onScanRecoveryDismiss}
        />
        {/* Stage D: persistent held-orders strip */}
        {registerId && activeShiftId && (
          <HeldOrdersBar
            registerId={registerId}
            shiftId={activeShiftId}
            hasActiveCart={cart.items.length > 0}
            onRecall={(restoredCart) => cart.restoreCart(restoredCart)}
          />
        )}
        {/* Customer */}
        <div className="p-3 xl:p-4 border-b">
          <Button
            variant="outline"
            className="w-full justify-start text-sm"
            onClick={onOpenCustomer}
          >
            <User className="h-4 w-4 mr-2" />
            {cart.customer ? cart.customer.name : "Add Customer"}
          </Button>
        </div>

        {/* Cart Items */}
        <BasketPanel cart={cart} sound={sound} formatCurrency={formatCurrency} />

        {/* Cart Summary */}
        <div className="border-t p-3 xl:p-4 space-y-3 xl:space-y-4">
          <TransactionSummaryRail
            cart={cart}
            appliedPromotions={appliedPromotions}
            formatCurrency={formatCurrency}
          />

          <SaleActionBar
            cart={cart}
            isTableSession={isTableSession}
            canHold={canHold}
            heldCount={heldCount}
            formatCurrency={formatCurrency}
            callbacks={saleActionBarCallbacks}
          />
        </div>
      </div>
    </div>
  );
}