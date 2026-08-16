// POS Terminal - Offline-capable version with full integrations
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { 
  Search, 
  Plus, 
  Minus, 
  Trash2, 
  User,
  CreditCard,
  Banknote,
  X,
  Pause,
  LogOut,
  Grid3X3,
  List,
  Clock,
  Tag,
  RotateCcw,
  Receipt,
  Wallet,
  Play,
  Star,
  Gift,
  Scale,
  ShieldAlert,
  Wifi,
  WifiOff,
  Lock,
  Monitor,
  MonitorOff,
  Printer,
  UtensilsCrossed,
  Sparkles,
  Split,
  DollarSign,
  Smartphone
} from "lucide-react";
import { usePOSProducts } from "@/hooks/pos/usePOSProducts";
import { useActiveScanContext } from "@/hooks/pos/useActiveScanContext";
import { useCart } from "@/apps/pos/terminal/sale/CartContext";
import { usePOSShifts } from "@/hooks/pos/usePOSShifts";
import { usePOSTransactionOffline } from "@/hooks/pos/usePOSTransactionOffline";
import { useCommitKey } from "@/hooks/pos/useCommitKey";
import { usePOSHeldTransactions } from "@/hooks/pos/usePOSHeldTransactions";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { usePOSLoyalty } from "@/hooks/pos/usePOSLoyalty";
import { usePOSAgeVerification } from "@/hooks/pos/usePOSAgeVerification";
import { usePOSOffline } from "@/hooks/pos/usePOSOffline";
import { usePOSSessionsOffline } from "@/hooks/pos/usePOSSessionsOffline";
import { useHardwareProxy } from "@/hooks/hardware/useHardwareProxy";
import { useIntentReadiness } from "@/hooks/hardware/useIntentReadiness";
import { useCustomerDisplay } from "@/hooks/pos/useCustomerDisplay";
import { domainEventBus } from "@/services/events/domainEventBus";
import { TerminalStateBridge, useTerminalContext } from "@/apps/pos/terminal";
import { usePOSPromotions } from "@/hooks/pos/usePOSPromotions";
import { useHappyHour } from "@/hooks/pos/useHappyHour";
import { useKitchenDisplay } from "@/hooks/pos/useKitchenDisplay";
import { useModifiers, type SelectedModifier } from "@/hooks/pos/useModifiers";
import { usePOSEtims } from "@/hooks/pos/usePOSEtims";
import { useBillSplitting, type SplitBillPortion } from "@/hooks/pos/useBillSplitting";
import { usePOSSecuritySettings } from "@/hooks/pos/usePOSSecuritySettings";
import { usePOSSecurityAudit } from "@/hooks/pos/usePOSSecurityAudit";
import { CloseShiftDialog } from "@/components/pos/CloseShiftDialog";
import { TenderWorkspace } from "@/apps/pos/terminal/tender/TenderWorkspace";
import { usePOSRegisters } from "@/hooks/pos/usePOSRegisters";
import { CustomerSelectDialog } from "@/components/pos/CustomerSelectDialog";
import { HeldWorkspace } from "@/apps/pos/terminal/held/HeldWorkspace";
import { HeldOrdersBar } from "@/components/pos/HeldOrdersBar";
import { KeyboardShortcutsOverlay } from "@/components/pos/KeyboardShortcutsOverlay";
import { useDrawerPolicy } from "@/hooks/pos/useDrawerPolicy";
import { parseScanPayload } from "@/services/pos/parseBarcode";
import { interpretScan } from "@/lib/gs1/useGs1Scanner";
// useScanCapture is mounted globally in AuthenticatedShell
import { useResolveBarcode } from "@/hooks/pos/useResolveBarcode";
import { identityOutcomeLine } from "@/features/products/identity/identityOutcome";
import { scanBus, type ScanEvent } from "@/services/pos/scanBus";
import { scanRouter } from "@/services/pos/scanRouter";
import { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";
import { ScanGhostTicker } from "@/components/pos/ScanGhostTicker";
import { ScanRecoveryBanner } from "@/components/pos/ScanRecoveryBanner";
import { MobileScannerDialog } from "@/components/pos/MobileScannerDialog";
import { usePOSScannerChannel } from "@/hooks/pos/usePOSScannerChannel";
import { useScannerScopeMode } from "@/hooks/scanner/useScannerScopePolicy";
import { CashDrawerDialog } from "@/components/pos/CashDrawerDialog";
import { DiscountDialog } from "@/components/pos/DiscountDialog";
import { ReturnWorkspace } from "@/apps/pos/terminal/return/ReturnWorkspace";
import { HistoryWorkspace } from "@/apps/pos/terminal/history/HistoryWorkspace";
import { ReceiptPreviewSheet } from "@/apps/pos/terminal/sale/ReceiptPreviewSheet";
import { ReceiptWorkspace } from "@/apps/pos/terminal/receipt/ReceiptWorkspace";
import { LoyaltyRedemptionDialog } from "@/components/pos/LoyaltyRedemptionDialog";
import { AgeVerificationDialog } from "@/components/pos/AgeVerificationDialog";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { TerminalLockScreen } from "@/components/pos/TerminalLockScreen";
import { ModifierSelectionDialog } from "@/components/pos/restaurant/ModifierSelectionDialog";
import { POSUnitSelectDialog, type UnitSelection } from "@/components/pos/POSUnitSelectDialog";
import { BillSplitDialog } from "@/components/pos/restaurant/BillSplitDialog";
import { TableTransferDialog } from "@/components/pos/restaurant/TableTransferDialog";
import { SoundToggleButton } from "@/components/pos/SoundToggleButton";
import { usePOSSound } from "@/hooks/pos/usePOSSound";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useReceiptData } from "@/apps/pos/terminal/receipt/ReceiptDataContext";
import { useCurrency } from "@/hooks/useCurrency";
import { useTableSessions } from "@/hooks/pos/useTableSessions";
import { useFloorPlan } from "@/hooks/pos/useFloorPlan";
import { ProductDiscoveryPanel } from "@/apps/pos/terminal/sale/components/ProductDiscoveryPanel";
import { BasketPanel } from "@/apps/pos/terminal/sale/components/BasketPanel";
import { TransactionSummaryRail } from "@/apps/pos/terminal/sale/components/TransactionSummaryRail";
import { SaleActionBar, type SaleActionBarCallbacks } from "@/apps/pos/terminal/sale/components/SaleActionBar";
import { SaleWorkspace } from "@/apps/pos/terminal/sale/SaleWorkspace";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { CartItemModifier } from "@/hooks/pos/usePOSCart";
import { usePOSKeyboardShortcuts } from "@/hooks/pos/usePOSKeyboardShortcuts";
import { useRegisterBranchGuard } from "@/hooks/pos/useRegisterBranchGuard";
import { CrossBranchRedirect } from "@/components/pos/CrossBranchRedirect";
// usePOSCart is now used via usePOSCartAdapter
import {
  openSession as openPaymentSession,
  recordTender as recordPaymentTender,
  commitSession as commitPaymentSession,
  type PosTenderKind,
} from "@/lib/pos/paymentSessionClient";

/**
 * Stage B branch isolation guard wrapper. Doing the guard in an outer
 * component avoids violating the Rules of Hooks: we never call any of
 * the inner terminal's many hooks when the operator is in the wrong
 * branch context. If the register belongs to another branch we render
 * the redirect panel and unmount the terminal entirely.
 */
export default function POSTerminal() {
  const { registerId } = useParams<{ registerId: string }>();
  const branchGuard = useRegisterBranchGuard(registerId);
  if (branchGuard.status === "wrong-branch") {
    return (
      <CrossBranchRedirect
        registerBranchId={branchGuard.registerBranchId}
        registerBranchName={branchGuard.registerBranchName}
        activeBranchId={branchGuard.activeBranchId}
      />
    );
  }
  return <POSTerminalInner />;
}

function POSTerminalInner() {
  const { registerId } = useParams<{ registerId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Declare active workspace scan context so dispatched scans land in
  // `scan_events` keyed by this register. Cleared on unmount.
  useActiveScanContext(registerId ? { register_id: registerId } : null);
  
  // Restaurant mode - table context from URL
  const tableId = searchParams.get("table");
  const tableSessionId = searchParams.get("session");
  const tableNumber = searchParams.get("tableNumber"); // Optional, passed from floor plan
  
  const { registers } = usePOSRegisters();
  const currentRegister = registers.find(r => r.id === registerId);
  const registerPaymentMethods = currentRegister?.default_payment_methods as string[] | null;

  const registerProductScope = useMemo(() => {
    if (!currentRegister) return undefined;
    const settings = currentRegister.settings as Record<string, unknown> | null;
    if (!settings?.product_scope || settings.product_scope === "all") return undefined;
    return {
      product_scope: settings.product_scope as "all" | "by_category" | "specific",
      product_scope_categories: settings.product_scope_categories as string[] | undefined,
      product_scope_ids: settings.product_scope_ids as string[] | undefined,
    };
  }, [currentRegister]);

  const { 
    products,
    filteredProducts, 
    categories, 
    isLoading: productsLoading,
    errorMessage: productsErrorMessage,
    searchQuery,
    setSearchQuery,
    selectedCategory,
    setSelectedCategory,
    findByBarcode,
    totalCount: productsTotalCount,
    loadedCount: productsLoadedCount,
    hasMore: productsHasMore,
    fetchNextPage: fetchMoreProducts,
    isFetchingNextPage: isFetchingMoreProducts,
  } = usePOSProducts(registerProductScope);
  
  const { 
    currentShift, 
    userCurrentShift,
    isLoadingCurrentShift 
  } = usePOSShifts(registerId);
  
  // Use the shift for this specific register, or fall back to user's current shift if on same register
  const activeShift = currentShift || (userCurrentShift?.register_id === registerId ? userCurrentShift : null);

  // Branch-true on-hand for the "Low" badge. The cached `product.stock_quantity`
  // is a company-wide aggregate — using it would mark a product as in-stock at
  // a branch that holds zero. Read warehouse_stock for the shift's branch.
  const shiftBranchId = (activeShift as any)?.branch_id ?? currentRegister?.branch_id ?? null;
  const shiftBusinessId = (activeShift as any)?.business_id ?? currentRegister?.business_id ?? null;
  const { data: branchOnHand = new Map<string, number>() } = useQuery({
    queryKey: ["pos-branch-on-hand", shiftBusinessId, shiftBranchId],
    queryFn: async () => {
      if (!shiftBusinessId || !shiftBranchId) return new Map<string, number>();
      const { data, error } = await supabase
        .from("warehouse_stock")
        .select("product_id, quantity")
        .eq("business_id", shiftBusinessId)
        .eq("branch_id", shiftBranchId);
      if (error) throw error;
      const map = new Map<string, number>();
      for (const r of data || []) {
        map.set(r.product_id, (map.get(r.product_id) || 0) + (Number(r.quantity) || 0));
      }
      return map;
    },
    enabled: !!shiftBusinessId && !!shiftBranchId,
    staleTime: 30_000,
  });
  
  // Cart ownership lifted to <CartProvider> in TerminalShell (Step 6).
  // The provider reads tableSessionId + tableNumber from URL search
  // params itself so sibling routes see the same cart instance.
  const cart = useCart();
  const { completeTransaction } = usePOSTransactionOffline();
  const commitKey = useCommitKey();
  const sound = usePOSSound();
  const { heldCount, holdTransaction } = usePOSHeldTransactions(registerId);
  const { receiptSettings } = usePOSSettings();
  const { program: loyaltyProgram, calculatePoints, fetchCustomerLoyalty } = usePOSLoyalty();
  const { isVerified: ageVerified, getRestrictedItems, verify: verifyAge, reset: resetAgeVerification, needsVerification } = usePOSAgeVerification();
  const { isOnline, queueCount } = usePOSOffline();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // Stage W6 (ADR-0008) — resolved per-tenant print policy for POS
  // receipts is now provided by <ReceiptDataProvider> mounted in
  // TerminalShell (Slice C.1). The completed transaction payload lives
  // there too so the receipt phase can become a route-owned sibling
  // (Slice C.2) without POSTerminal being on screen. Until Step 6 fully
  // decomposes this monolith, POSTerminal remains the writer.
  const {
    transaction: completedTransaction,
    setTransaction: setCompletedTransaction,
    policy: postPaymentPolicy,
  } = useReceiptData();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  // Set of product IDs that have at least one packaging level defined. Used to
  // decide whether tapping a tile opens the unit picker (Box/Strip/Each) or
  // adds the base unit directly. One lightweight query per business.
  // Products with at least one packaging level, derived from the canonical
  // product read seam (the RPC already returns packaging levels) — POS does
  // not issue its own product_packaging query.
  const packagedProductIds = useMemo(
    () => new Set(products.filter((p) => (p.packaging?.length ?? 0) > 0).map((p) => p.id)),
    [products],
  );
  const { settings: securitySettings } = usePOSSecuritySettings();
  const queryClient = useQueryClient();
  
  
  // Promotions engine
  const { promotions, evaluatePromotions, validatePromoCode } = usePOSPromotions();
  
  // Happy hour pricing
  const { getDiscountedPrice, getActiveHappyHours } = useHappyHour();
  
  // Kitchen display (restaurant mode)
  const { createOrder: createKitchenOrder } = useKitchenDisplay();
  
  // eTIMS fiscal compliance
  const { etimsSettings, transmitToEtims, isEtimsEnabled } = usePOSEtims(registerId);
  
  // Bill splitting (restaurant mode)
  const { splitBill, createSplitBill, markPortionPaid, getUnpaidPortions } = useBillSplitting(tableSessionId || undefined);
  
  // Table sessions & floor plan data for transfer dialog (restaurant mode)
  const { sessions: allActiveSessions } = useTableSessions(activeShift?.id);
  const { floors: allFloors, useFloorTables } = useFloorPlan();
  const firstFloorId = allFloors.find(f => f.is_active)?.id ?? null;
  const { data: allFloorTables = [] } = useFloorTables(firstFloorId);
  
  // Compute available sessions (exclude current) and available empty tables for transfer dialog
  const transferAvailableSessions = useMemo(() => {
    if (!tableSessionId) return [];
    return (allActiveSessions || [])
      .filter(s => s.id !== tableSessionId && s.status !== "closed" && s.status !== "paid")
      .map(s => ({
        id: s.id,
        tableName: `Table ${s.table?.table_number || s.table_id.slice(0, 4)}`,
        tableNumber: s.table?.table_number || "",
      }));
  }, [allActiveSessions, tableSessionId]);

  const transferAvailableTables = useMemo(() => {
    if (!tableId) return [];
    return allFloorTables
      .filter(t => t.id !== tableId && !t.current_session)
      .map(t => ({
        id: t.id,
        name: `Table ${t.table_number}`,
        number: t.table_number,
      }));
  }, [allFloorTables, tableId]);
  // Tip state
  const [tipAmount, setTipAmount] = useState(0);
  const paymentSessionIdempotencyKey = useMemo(() => {
    if (!registerId || !activeShift?.id) return "";
    return `${commitKey.get(registerId, activeShift.id)}:${Math.round((cart.total + (tipAmount || 0)) * 100)}`;
  }, [registerId, activeShift?.id, commitKey, cart.total, tipAmount]);
  
  // Hardware — proxy-based device management (replaces old direct-service approach)
  const { openDrawer: openDrawerHw, printRawBytes } = useHardwareProxy(registerId);
  // Printer badge readiness. NOT `printerStatus()`: that is the renderer's
  // LOCAL transport probe, and a till printer owned by another machine's IoT
  // agent (reached over the `edge_jobs` relay) is never "connected" locally —
  // which is exactly why POS showed "Disconnected" while the printer was
  // online and printing fine. Readiness is a registry + workstation-heartbeat
  // question, answered once in `services/hardware/readiness.ts`.
  const receiptReadiness = useIntentReadiness("receipt", {
    scope: registerId ? { kind: "register", id: registerId } : undefined,
  });

  
  // Customer display for secondary screen.
  // NOTE: Writes to the display are owned exclusively by
  // BusinessSagaMount (subscribes to pos.cart_total_changed /
  // pos.payment_completed / pos.session_idle). This hook only retains
  // open/close lifecycle + liveness + ad-hoc messages.
  const {
    isConnected: isDisplayConnected,
    isLoading: isDisplayLoading,
    open: openCustomerDisplay,
    close: closeCustomerDisplay,
    showMessage: showDisplayMessage,
  } = useCustomerDisplay();
  
  // Terminal security & session management (unified offline-capable hook)
  const {
    activeSession,
    isLoadingSession,
    assignedCashiers,
    shouldShowLockScreen,
    isLocked,
    autoLockMinutes,
    login: loginCashier,
    isLoggingIn,
    managerLogin,
    isManagerLoggingIn,
    unlockSession,
    isUnlocking,
    lockSession,
    logout: logoutCashier,
  } = usePOSSessionsOffline(currentOrg?.id, registerId);
  
  const [loginError, setLoginError] = useState<string | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const sessionStartRef = useRef<number>(Date.now());
  
  // Compute effective inactivity lock: prefer security settings, fallback to register setting
  const effectiveLockMinutes = useMemo(() => {
    const fromSecuritySettings = securitySettings.lock_after_inactivity_minutes;
    // If security settings has a value > 0, use it; otherwise fallback to register auto_lock_minutes
    if (fromSecuritySettings && fromSecuritySettings > 0) return fromSecuritySettings;
    return autoLockMinutes || 0;
  }, [securitySettings.lock_after_inactivity_minutes, autoLockMinutes]);

  // Session timeout: force logout when session exceeds session_timeout_minutes
  useEffect(() => {
    const timeoutMinutes = securitySettings.session_timeout_minutes;
    if (!timeoutMinutes || timeoutMinutes <= 0 || !activeSession || isLocked) return;
    
    // Reset session start when session changes
    sessionStartRef.current = Date.now();
    
    const checkSessionTimeout = () => {
      const elapsedMs = Date.now() - sessionStartRef.current;
      const timeoutMs = timeoutMinutes * 60 * 1000;
      
      if (elapsedMs >= timeoutMs) {
        toast.warning("Session timed out. Please log in again.");
        logoutCashier();
      }
    };
    
    const interval = setInterval(checkSessionTimeout, 30000);
    
    return () => clearInterval(interval);
  }, [securitySettings.session_timeout_minutes, activeSession, isLocked, logoutCashier]);
  
  // Auto-lock after inactivity (uses effective lock minutes from security settings or register)
  useEffect(() => {
    if (!effectiveLockMinutes || !activeSession || isLocked) return;
    
    const checkInactivity = () => {
      const inactiveMs = Date.now() - lastActivityRef.current;
      const lockAfterMs = effectiveLockMinutes * 60 * 1000;
      
      if (inactiveMs >= lockAfterMs) {
        lockSession('Auto-locked due to inactivity');
      }
    };
    
    const interval = setInterval(checkInactivity, 30000); // Check every 30 seconds
    
    // Reset activity timer on user interaction
    const resetActivity = () => {
      lastActivityRef.current = Date.now();
    };
    
    window.addEventListener('click', resetActivity);
    window.addEventListener('keydown', resetActivity);
    window.addEventListener('touchstart', resetActivity);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('click', resetActivity);
      window.removeEventListener('keydown', resetActivity);
      window.removeEventListener('touchstart', resetActivity);
    };
  }, [effectiveLockMinutes, activeSession, isLocked, lockSession]);
  
  // Handle cashier login
  const handleCashierLogin = useCallback((cashierId: string, pin: string) => {
    setLoginError(null);
    loginCashier(
      { cashierId, registerId: registerId!, pin },
      {
        onError: (error: Error) => {
          setLoginError(error.message);
        },
      }
    );
  }, [loginCashier, registerId]);
  
  // Handle unlock
  const handleUnlock = useCallback((pin: string) => {
    setLoginError(null);
    unlockSession(pin, {
      onError: (error: Error) => {
        setLoginError(error.message);
      },
    });
  }, [unlockSession]);
  
  // Handle manager login
  const handleManagerLogin = useCallback((pin: string) => {
    setLoginError(null);
    if (!currentOrg?.id) return;
    managerLogin(
      { registerId: registerId!, pin, organizationId: currentOrg.id },
      {
        onError: (error: Error) => {
          setLoginError(error.message);
        },
      }
    );
  }, [managerLogin, registerId, currentOrg]);
  
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  // Phase 2 (POS workstation): tender lifecycle is owned by the terminal
  // reducer — `showPayment` is now a derived read of `phase === 'tender'`.
  // Any surface that used to call `setShowPayment(true)` now dispatches
  // `openTender` (which freezes the idempotency key at the exact moment
  // the operator entered tender, preserving the retail-vs-restaurant
  // contract from the pre-refactor implementation).
  const { state: terminalState, dispatch: terminalDispatch, openSheet } = useTerminalContext();
  const showPayment = terminalState.phase === "tender";
  const openTender = useCallback(() => {
    // Phase 4 — pricing authority. Tender is only allowed against a
    // server-quoted basket (`pos_quote_cart`). If the pricing authority is
    // unreachable or the quote does not yet describe the current cart we
    // FAIL CLOSED rather than taking money against locally computed money.
    if (cart.items.length > 0 && !cart.isPricingAuthoritative) {
      if (cart.pricingStatus === "pending" || cart.isQuoting) {
        toast.info("Confirming prices with the server…");
      } else {
        toast.error("Prices could not be confirmed with the server. Payment is blocked.");
        cart.refetchQuote?.();
      }
      return;
    }
    terminalDispatch({
      kind: "op",
      op: "openTender",
      idempotencyKey:
        cart.isRestaurantMode && cart.transactionId
          ? cart.transactionId
          : paymentSessionIdempotencyKey,
    });
  }, [
    terminalDispatch,
    cart.isRestaurantMode,
    cart.transactionId,
    cart.items.length,
    cart.isPricingAuthoritative,
    cart.pricingStatus,
    cart.isQuoting,
    cart.refetchQuote,
    paymentSessionIdempotencyKey,
  ]);
  const setShowPayment = useCallback(
    (next: boolean) => {
      if (next) openTender();
      else terminalDispatch({ kind: "op", op: "backToSale" });
    },
    [openTender, terminalDispatch],
  );
  const [showCustomer, setShowCustomer] = useState(false);
  const [showCloseShift, setShowCloseShift] = useState(false);
  const [showCashDrawer, setShowCashDrawer] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  // `showReceipt` retired: the pro-forma "Print Bill" preview is now a
  // sale-workspace sheet (`sale.receiptPreview`) owned by the reducer.
  // Triggers below call `openSheet("sale.receiptPreview")`; the sheet
  // auto-dismisses on phase change.
  // Phase 3 (POS workstation): side-transitions (Held / Return / History)
  // are owned by the terminal reducer. `showHeld/Return/History` become
  // derived reads of the current phase; opening dispatches an operator
  // intent, closing dispatches `closeSide` which restores previousPhase.
  // Sheet-shells inside the mounted workspace already auto-dismiss on
  // phase change, so we get the "only one side workspace at a time"
  // invariant for free from the state machine.
  const showHeld = terminalState.phase === "held";
  const showReturn = terminalState.phase === "return";
  const showHistory = terminalState.phase === "history";
  const setShowHeld = useCallback(
    (next: boolean) => {
      if (next) terminalDispatch({ kind: "op", op: "openHeld" });
      else if (terminalState.phase === "held") terminalDispatch({ kind: "op", op: "closeSide" });
    },
    [terminalDispatch, terminalState.phase],
  );
  const setShowReturn = useCallback(
    (next: boolean) => {
      if (next) terminalDispatch({ kind: "op", op: "openReturn" });
      else if (terminalState.phase === "return") terminalDispatch({ kind: "op", op: "closeSide" });
    },
    [terminalDispatch, terminalState.phase],
  );
  const setShowHistory = useCallback(
    (next: boolean) => {
      if (next) terminalDispatch({ kind: "op", op: "openHistory" });
      else if (terminalState.phase === "history") terminalDispatch({ kind: "op", op: "closeSide" });
    },
    [terminalDispatch, terminalState.phase],
  );
  // Stage X3 / Phase 3c — full post-payment surface is now the routed
  // `ReceiptWorkspace`; its visibility is derived from
  // `terminalState.phase === "receipt"` inside the workspace itself,
  // so `POSTerminal` no longer maintains a sibling boolean.
  const [showLoyalty, setShowLoyalty] = useState(false);
  const [showAgeVerification, setShowAgeVerification] = useState(false);
  const [showMobileCart, setShowMobileCart] = useState(false);
  const [showEmailReceipt, setShowEmailReceipt] = useState(false);
  const [showModifiers, setShowModifiers] = useState(false);
  const [showBillSplit, setShowBillSplit] = useState(false);
  const [showTableTransfer, setShowTableTransfer] = useState(false);
  const [showTip, setShowTip] = useState(false);
  const [showMobileScanner, setShowMobileScanner] = useState(false);
  const [pendingProduct, setPendingProduct] = useState<typeof filteredProducts[0] | null>(null);
  // Multi-unit (Box / Strip / Each) selection when tapping a product tile.
  const [unitSelectProduct, setUnitSelectProduct] = useState<typeof filteredProducts[0] | null>(null);
  const [showUnitSelect, setShowUnitSelect] = useState(false);
  const [appliedPromotions, setAppliedPromotions] = useState<Array<{ promotion: { name: string }; discountAmount: number }>>([]);
  const activeHappyHours = getActiveHappyHours();
  const [customerLoyalty, setCustomerLoyalty] = useState<{ points_balance: number; current_tier: string } | null>(null);
  const [splitPortionToPay, setSplitPortionToPay] = useState<SplitBillPortion | null>(null);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  // `completedTransaction` + `setCompletedTransaction` now come from
  // <ReceiptDataProvider> (see hook usage near the top of this
  // component). The old useState block was removed in Slice C.1.
  
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Stage 2: global keyboard shortcut layer (cashier hot path).
  // Disabled while terminal is locked, while a payment is processing, or
  // while there is no open shift — those are the moments where stray F-keys
  // could cause harm.
  usePOSKeyboardShortcuts({
    enabled: !isLocked && !isProcessingPayment && !!activeShift,
    onDiscount: () => {
      if (cart.items.length > 0) setShowDiscount(true);
    },
    onCustomer: () => setShowCustomer(true),
    onHold: () => {
      if (
        cart.items.length > 0 &&
        activeShift &&
        registerId &&
        currentOrg
      ) {
        holdTransaction.mutate({
          register_id: registerId,
          shift_id: activeShift.id,
          organization_id: currentOrg.id,
          cart: cart.cartState,
        });
        cart.clearCart();
        sound.play("hold");
      }
    },
    onRecallHeld: () => setShowHeld(true),
    onPay: () => {
      if (cart.items.length > 0) setShowPayment(true);
    },
    onCashDrawer: () => setShowCashDrawer(true),
  });

  // Redirect if no active shift
  useEffect(() => {
    if (!isLoadingCurrentShift && !activeShift) {
      navigate("/pos");
    }
  }, [activeShift, isLoadingCurrentShift, navigate]);
  
  // Customer-display event layer (Loop B1). The BusinessSagaMount
  // subscriber is the single writer to `customerDisplayClient`; this
  // effect only publishes intent. Emits:
  //   - pos.cart_total_changed   on every cart mutation (saga dedupes)
  //   - pos.session_idle         when the cart transitions from non-empty to empty
  // pos.payment_completed is emitted from handlePaymentComplete.
  // The legacy in-process display calls were removed to eliminate
  // double-fires now that the saga owns the display.
  const prevCartRef = useRef<{ length: number }>({ length: 0 });
  useEffect(() => {
    if (!currentBusiness?.id) return;
    const orgId = currentBusiness.id;
    const occurredAt = new Date().toISOString();
    const prev = prevCartRef.current;
    const currLen = cart.items.length;

    // cart_total_changed: always, the saga dedupes
    void domainEventBus.publish({
      type: 'pos.cart_total_changed',
      orgId,
      branchId: shiftBranchId,
      sourceDocType: 'pos_session',
      sourceDocId: activeShift?.id ?? 'cart',
      occurredAt,
      payload: {
        itemCount: currLen,
        items: cart.items.map((it) => ({
          id: (it as { id?: string }).id ?? it.product_id,
          name: it.name,
          quantity: it.quantity,
          unitPrice: it.unit_price,
          lineTotal: it.line_total,
        })),
        subtotal: cart.subtotal,
        tax: cart.tax_amount,
        discount: cart.discount_amount,
        total: cart.total,
        currency: currentBusiness?.base_currency,
        customerName: cart.cartState.customer?.name ?? null,
      },
    });

    // session_idle: cart drained
    if (prev.length > 0 && currLen === 0) {
      void domainEventBus.publish({
        type: 'pos.session_idle',
        orgId,
        branchId: shiftBranchId,
        sourceDocType: 'pos_session',
        sourceDocId: activeShift?.id ?? 'cart',
        occurredAt,
        payload: { registerId: registerId ?? null },
      });
    }

    prevCartRef.current = { length: currLen };
  }, [cart.items, cart.subtotal, cart.tax_amount, cart.discount_amount, cart.total, cart.cartState.customer, currentBusiness?.base_currency, currentBusiness?.id, shiftBranchId, activeShift?.id, registerId]);


  // Handle barcode scanner input. Honors the Odoo-style `n*<barcode>` qty
  // multiplier so a single scan of `3*1234567` adds qty 3 in one cart upsert
  // (H1 — cashier fatigue: no need to scan the same item N times).
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && searchQuery) {
      // GS1 first: collapse a DataMatrix / QR payload to its GTIN so the
      // downstream resolver hits `pos_resolve_barcode` on the primary
      // identifier. `interpretScan` is a no-op for plain scans.
      const gs1 = interpretScan(searchQuery);
      const { code, quantity } = parseScanPayload(gs1.resolveCode);
      void handleScan(code, quantity, "manual");
      setSearchQuery("");
    }
  };

  // Scanner kernel + server-indexed resolver (Stage POS-Scan v2).
  // The kernel is mounted globally in AuthenticatedShell so any focused
  // BarcodeInputField across the app gets scans. Consumers subscribe via
  // scanBus / scanRouter. The resolver hits pos_resolve_barcode with an
  // LRU cache.
  // Phone-as-scanner: subscribe to `pos:scan:<registerId>` broadcasts and
  // mirror them onto the in-process scanBus so the existing resolve →
  // cart path handles camera scans identically to keyboard-wedge ones.
  const {
    connectedDevices: pairedScanners,
    revoke: revokePairedScanner,
    lastScanByDevice: pairedScannerLastScans,
  } = usePOSScannerChannel(registerId);
  // Scanner Scope policy — in `scoped` mode the cart accepts ONLY scans
  // from its own register topic (or no topic at all, i.e. keyboard/manual).
  // This stops a workspace-paired phone from injecting into the POS cart
  // when the cashier and a stock clerk share a workstation.
  const scopeMode = useScannerScopeMode(currentBusiness?.id ?? null);
  const ownRegisterTopic = registerId ? `pos:scan:${registerId}` : null;
  const { resolveTagged: resolveBarcode } = useResolveBarcode(
    currentBusiness?.id,
    shiftBranchId,
  );

  const [unknownScan, setUnknownScan] = useState<{ code: string; reason: string } | null>(null);

  const handleScan = useCallback(
    async (code: string, qtyMultiplier: number, source: ScanEvent["source"]) => {
      const norm = code.trim();
      if (!norm) return;
      // Sub-100ms perceptual feedback: tell the cashier we accepted the
      // scan before the resolver round-trips.
      scanFeedbackBus.emit({ kind: "pending", raw: norm, detail: "Looking up…" });
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      const result = await resolveBarcode(norm);
      if (result.kind === "error") {
        // Network blip — distinct from "Unknown barcode". The resolver
        // already retried once, so surface a soft "retry" state instead
        // of an unknown-barcode banner that pollutes the cashier's view.
        scanFeedbackBus.emit({ kind: "error", raw: norm, detail: "Network blip — please rescan" });
        sound.play("error");
        return;
      }
      if (result.kind === "miss") {
        const reason = offline
          ? "Offline — code not cached"
          : identityOutcomeLine({
              status: result.status,
              code: norm,
              matchCount: result.matchCount,
              productName: result.productName,
            });
        scanFeedbackBus.emit({ kind: "unknown", raw: norm, detail: reason });
        sound.play("error");
        setUnknownScan({ code: norm, reason });
        return;
      }
      const resolved = result.row;
      // Effective qty: scanner qty-multiplier × pack quantity from RPC.
      const qty = Math.max(1, qtyMultiplier) * (resolved.scanQuantity || 1);
      // For weighted_price labels the unit price is overridden by the
      // embedded total and qty becomes 1 (the price IS the line total).
      const unitPrice = resolved.embeddedPrice != null
        ? resolved.embeddedPrice
        : resolved.sellingPrice;
      const lineQty = resolved.embeddedPrice != null
        ? 1
        : (resolved.scanWeight != null ? resolved.scanWeight : qty);

      cart.addItem({
        id: resolved.productId,
        name: resolved.name,
        sku: resolved.sku || undefined,
        price: unitPrice,
        tax_rate: resolved.taxRate || 0,
        cost_price: resolved.costPrice || undefined,
        tax_rate_id: resolved.taxRateId || undefined,
        tax_rate_name: resolved.taxRateName || undefined,
        etims_tax_code: resolved.etimsTaxCode || undefined,
        category_id: resolved.categoryId || undefined,
        // Packaging / UoM provenance — when the scan resolved to a pack
        // (carton/case/strip), the RPC returns the packaging row id and the
        // product's base UoM. Cart line keeps base-unit `quantity` for the
        // ledger and remembers what the cashier actually scanned.
        packaging_id: resolved.packagingId,
        base_uom_id: resolved.baseUomId,
        display_quantity: resolved.packagingId ? Math.max(1, qtyMultiplier) : null,
      }, lineQty);

      scanFeedbackBus.emit({
        kind: resolved.matchedRuleKind?.startsWith("weighted") ? "weighted" : "ok",
        raw: norm,
        detail: `${resolved.name}${lineQty !== 1 ? ` ×${lineQty}` : ""}`,
      });
      sound.play("barcode_scan");
      // Successful scan clears any prior unknown-code banner.
      setUnknownScan(null);
      if (source === "manual") setSearchQuery("");
    },
    [resolveBarcode, cart, sound, setSearchQuery],
  );

  // Subscribe the terminal to global scan events from the kernel.
  // Skip any event already consumed by a higher-priority scanRouter target
  // (e.g. a focused <BarcodeInputField> inside an inline dialog).
  useEffect(() => {
    const unsub = scanBus.on((event) => {
      if (scanRouter.wasConsumed(event)) return;
      // Scoped mode: drop scans that come from a different paired channel.
      // Keyboard / manual / native scans have no sourceTopic and always pass.
      if (scopeMode === "scoped" && event.sourceTopic) {
        if (event.sourceTopic !== ownRegisterTopic) return;
      }
      // GS1 collapse: DataMatrix / QR payload → GTIN before resolver.
      const gs1 = interpretScan(event.code);
      void handleScan(gs1.resolveCode, event.quantity, event.source);
    });
    return unsub;
  }, [handleScan, scopeMode, ownRegisterTopic]);

  const handleProductClick = (product: typeof filteredProducts[0]) => {
    // Check happy hour pricing first
    const { price: effectivePrice, happyHour } = getDiscountedPrice(product.id, product.selling_price);
    
    // Store product reference for potential modifier dialog
    setPendingProduct(product);
    
    // TODO: Check if product has modifier groups and show dialog
    // For now, we check by attempting to query - but the ModifierSelectionDialog 
    // handles the case of no modifiers by auto-confirming
    // In restaurant mode (table context), always check for modifiers
    if (tableSessionId) {
      setShowModifiers(true);
      return;
    }

    // Multi-unit products (Box / Strip / Each) — let the cashier pick the
    // packaging level instead of defaulting to the base unit.
    if (packagedProductIds?.has(product.id)) {
      setUnitSelectProduct(product);
      setShowUnitSelect(true);
      return;
    }

    
    // Regular retail mode - add directly with happy hour price
    cart.addItem({
      id: product.id,
      name: product.name,
      sku: product.sku || undefined,
      price: effectivePrice,
      tax_rate: product.tax_rate || 0,
      cost_price: product.cost_price || undefined,
      category_id: product.category_id || undefined,
      tax_rate_id: product.tax_rate_id || undefined,
      tax_rate_name: product.tax_rate_name || undefined,
      etims_tax_code: product.etims_tax_code || undefined,
      base_uom_id: product.base_uom_id || undefined,
    });
    sound.play("product_click");
  };

  // Handle multi-unit (Box / Strip / Each) selection confirmation. The cart
  // ledger invariant is preserved: `quantity` is always base units and
  // `price` is per base unit, while packaging provenance is carried alongside.
  const handleUnitSelectConfirm = (selection: UnitSelection) => {
    const product = unitSelectProduct;
    if (!product) return;
    const factor =
      selection.displayQuantity > 0
        ? selection.baseQuantity / selection.displayQuantity
        : 1;
    const perBaseUnitPrice =
      factor > 0 ? selection.unitPrice / factor : selection.unitPrice;
    cart.addItem(
      {
        id: product.id,
        name: product.name,
        sku: product.sku || undefined,
        price: perBaseUnitPrice,
        tax_rate: product.tax_rate || 0,
        cost_price: product.cost_price || undefined,
        category_id: product.category_id || undefined,
        tax_rate_id: product.tax_rate_id || undefined,
        tax_rate_name: product.tax_rate_name || undefined,
        etims_tax_code: product.etims_tax_code || undefined,
        packaging_id: selection.packagingId,
        base_uom_id: selection.baseUomId,
        display_quantity: selection.displayQuantity,
        packaging_label: selection.packagingLabel,
      },
      selection.baseQuantity,
    );
    setUnitSelectProduct(null);
    setShowUnitSelect(false);
    sound.play("product_click");
  };


  // Handle modifier confirmation from dialog
  const handleModifierConfirm = (modifiers: SelectedModifier[], totalAdjustment: number) => {
    if (!pendingProduct) return;
    const { price: effectivePrice } = getDiscountedPrice(pendingProduct.id, pendingProduct.selling_price);
    
    cart.addItem({
      id: pendingProduct.id,
      name: pendingProduct.name,
      sku: pendingProduct.sku || undefined,
      price: effectivePrice,
      tax_rate: pendingProduct.tax_rate || 0,
      cost_price: pendingProduct.cost_price || undefined,
      category_id: pendingProduct.category_id || undefined,
      base_uom_id: pendingProduct.base_uom_id || undefined,
      tax_rate_id: pendingProduct.tax_rate_id || undefined,
      tax_rate_name: pendingProduct.tax_rate_name || undefined,
      etims_tax_code: pendingProduct.etims_tax_code || undefined,
      modifiers: modifiers.map(m => ({
        modifier_id: m.modifier_id,
        modifier_name: m.modifier_name,
        price_adjustment: m.price_adjustment,
      })),
      modifiers_total: totalAdjustment,
    });
    setPendingProduct(null);
    sound.play("product_click");
  };

  // Stage F — context-aware drawer policy resolver.
  const drawerPolicy = useDrawerPolicy({
    register: currentRegister as any,
    cashier: (activeSession as any)?.cashier ?? null,
  });

  const handlePaymentComplete = async (payments: Array<{ method: string; amount: number; tendered_amount?: number; change_given?: number; reference?: string; card_last_four?: string | null; card_type?: string | null; auth_state?: string | null; auth_id?: string | null; vendor_txn_id?: string | null; authorized_amount?: number | null }>) => {
    if (!activeShift || !registerId) return;
    // Defense in depth (Phase 4): never commit against unquoted money.
    if (cart.items.length > 0 && !cart.isPricingAuthoritative) {
      toast.error("Prices could not be confirmed with the server. Payment is blocked.");
      return;
    }

    // Capture cart state before clearing (needed for post-transaction integrations)
    const capturedCartState = { ...cart.cartState };
    const capturedCustomer = cart.cartState.customer;

    // Store cart data before clearing for receipt
    const cartData = {
      items: cart.cartState.items.map(item => ({
        product_name: item.name,
        sku: item.sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_amount: (item as { discount_amount?: number }).discount_amount ?? 0,
        line_total: item.line_total,
        // Multi-unit pack provenance — receipts and reprints render this.
        display_quantity: item.display_quantity ?? null,
        packaging_label: item.packaging_label ?? null,
      })),
      subtotal: cart.subtotal,
      tax_amount: cart.tax_amount,
      discount_amount: cart.discount_amount,
      total: cart.total + tipAmount,
      customer_name: cart.cartState.customer?.name,
    };

    // The transient "Processing payment…" display update used to live
    // here; it now rides the upcoming `pos.payment_started` event surface
    // when that saga handler lands. Cart-effect emits already keep the
    // display in sync up to the moment the dialog closes.


    // IMMEDIATELY close dialog and show processing state for instant feedback
    setShowPayment(false);
    setIsProcessingPayment(true);

    try {
      let result: { transaction: { id: string; created_at: string }; transactionNumber: string; change: number; isOffline?: boolean };

      // Restaurant mode: finalize existing draft transaction via the
      // payment-session lifecycle (Wave 3 · Phase 4.a).
      //
      //   openSession(idempotencyKey = cart.transactionId)
      //     → recordTender × N (key = `${cart.transactionId}:tender:${i}`)
      //     → commitSession(envelope.existing_transaction_id = cart.transactionId)
      //
      // The commit RPC materialises the tenders and forwards to
      // finalize_table_order server-side, so card FSM metadata and
      // idempotency behave identically to the retail path.
      if (cart.isRestaurantMode && cart.transactionId) {
        const draftId = cart.transactionId;

        const tenderKindFor = (m: string): PosTenderKind => {
          switch (m) {
            case "cash":          return "cash";
            case "card":          return "card";
            case "mobile_money":
            case "mpesa":         return "wallet";
            case "voucher":       return "voucher";
            case "credit":        return "credit_liability";
            case "bank_transfer": return "bank_transfer";
            default:              return "other";
          }
        };

        const grandTotal = cart.total + (tipAmount || 0);
        const sessionId = await openPaymentSession({
          registerId,
          grandTotal,
          currency: "KES",
          idempotencyKey: draftId,
          tipAmount: tipAmount || 0,
          cashierId: activeShift.cashier_id ?? null,
        });

        for (let i = 0; i < payments.length; i++) {
          const p = payments[i];
          const method = p.method === "mpesa" ? "mobile_money" : p.method;
          const tendered = p.tendered_amount ?? p.amount;
          const changeGiven = p.change_given ?? Math.max(0, tendered - p.amount);
          await recordPaymentTender({
            sessionId,
            idempotencyKey: `${draftId}:tender:${i}`,
            tender: {
              tender_kind: tenderKindFor(method),
              method_key: method,
              provider_key: method === "mobile_money" ? "mpesa" : undefined,
              amount: p.amount,
              tendered_amount: tendered,
              change_given: method === "cash" ? changeGiven : 0,
              reference: p.reference ?? null,
              auth_state: (p.auth_state as "approved" | "captured" | undefined) ?? undefined,
              auth_id: p.auth_id ?? null,
              vendor_txn_id: p.vendor_txn_id ?? null,
              driver_payload: {
                card_last_four: p.card_last_four ?? null,
                card_type: p.card_type ?? null,
                authorized_amount: p.authorized_amount ?? null,
              },
            },
          });
        }

        const commitEnvelope = await commitPaymentSession({
          sessionId,
          envelope: {
            existing_transaction_id: draftId,
          },
        });

        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
        result = {
          transaction: { id: commitEnvelope.transaction_id, created_at: new Date().toISOString() },
          transactionNumber: commitEnvelope.transaction_number ?? "",
          change: commitEnvelope.change ?? Math.max(0, totalPaid - cart.total),
        };
      } else {
        // Retail mode: create new transaction via RPC
        result = await completeTransaction.mutateAsync({
          register_id: registerId,
          shift_id: activeShift.id,
          cashier_id: activeShift.cashier_id ?? null,
          business_id: currentBusiness?.id,
          cart: cart.cartState,
          cart_discount: cart.cartDiscount ?? null,
          payments: payments.map(p => {
            const method = (p.method === "mpesa" ? "mobile_money" : p.method) as "cash" | "card" | "mobile_money" | "voucher" | "credit" | "bank_transfer" | "other";
            const tendered = p.tendered_amount ?? p.amount;
            const change = p.change_given ?? Math.max(0, tendered - p.amount);
            return {
              method,
              amount: p.amount,
              tendered_amount: tendered,
              change_given: method === "cash" ? change : 0,
              reference: p.reference,
              // Wave 2 · Phase C-2 — forward card FSM metadata to
              // `_pos_record_payment` so the row starts in a legal state.
              card_last_four: p.card_last_four,
              card_type: p.card_type,
              auth_state: p.auth_state as "approved" | "captured" | undefined,
              auth_id: p.auth_id,
              vendor_txn_id: p.vendor_txn_id,
              authorized_amount: p.authorized_amount,
            };
          }),

          table_session_id: tableSessionId || undefined,
          tip_amount: tipAmount || 0,
          idempotency_key: paymentSessionIdempotencyKey,
        });
      }
      
      // Prefetch the frozen receipt snapshot (written synchronously by the
      // _pos_write_receipt_snapshot trigger inside the same transaction) so
      // ReceiptPreviewDialog mounts with branding + receipt-settings
      // resolved on the FIRST paint — no "generic then real" double render.
      try {
        await queryClient.prefetchQuery({
          queryKey: ["pos-receipt-snapshot", result.transaction.id],
          queryFn: async () => {
            const { data } = await supabase
              .from("pos_receipt_snapshots" as never)
              .select("payload")
              .eq("transaction_id", result.transaction.id)
              .maybeSingle();
            return (data as { payload?: unknown } | null)?.payload ?? null;
          },
          staleTime: Infinity,
        });
      } catch (snapErr) {
        console.warn("[POS] receipt snapshot prefetch failed (non-fatal):", snapErr);
      }

      // Single-method shorthand for templates that key off `payment_method`.
      const paymentMethodSummary = payments.length === 1
        ? payments[0].method
        : payments.map(p => p.method).join(", ");

      // Prepare completed transaction for receipt — include every field the
      // receipt template branches on so the first paint matches the
      // configured layout (cashier, register, eTIMS, void/refund flags).
      setCompletedTransaction({
        id: result.transaction.id,
        transaction_number: result.transactionNumber,
        total_amount: cartData.total,
        subtotal: cartData.subtotal,
        tax_amount: cartData.tax_amount,
        discount_amount: cartData.discount_amount,
        created_at: result.transaction.created_at,
        customer_name: cartData.customer_name,
        cashier_name: user?.user_metadata?.full_name || user?.email || undefined,
        register_id: registerId,
        invoice_id: (result as { invoice_id?: string }).invoice_id ?? null,
        invoice_number: (result as { invoice_number?: string }).invoice_number ?? null,
        etims_cu_number: null,
        etims_qr_data: null,
        payment_method: paymentMethodSummary,
        is_voided: false,
        is_refund: false,
        original_transaction_number: null,
        items: cartData.items,
        payments: payments.map(p => {
          const tendered = p.tendered_amount ?? p.amount;
          const change = p.change_given ?? Math.max(0, tendered - p.amount);
          return {
            payment_method: p.method,
            amount: p.amount,
            tendered_amount: tendered,
            change_given: p.method === "cash" ? change : 0,
            reference: p.reference,
          };
        }),
      });
      
      cart.clearCart();
      setAppliedPromotions([]);
      setTipAmount(0);
      setSplitPortionToPay(null);
      sound.play("payment_success");

      // Stage F — context-aware drawer kick. Fires silently for cash tenders
      // (no reason prompt, zero clicks). Card / mobile / credit sales never
      // open the drawer. Failures never block the next sale; they're audited.
      try {
        if (drawerPolicy.shouldKickDrawer(payments.map(p => ({ method: p.method, amount: p.amount })))) {
          const hwResult = await openDrawerHw().catch((err: any) => ({ success: false, error: String(err?.message ?? err) }));
          sound.play("cash_drawer_open");
          // Audit row — never throw if this fails.
          const orgId = (currentRegister as any)?.organization_id;
          const bizId = currentBusiness?.id ?? (currentRegister as any)?.business_id;
          if (orgId && bizId) {
            // H6 — go through SECURITY DEFINER RPC so the row shape, branch
            // stamping, and triggered_by are canonicalized server-side.
            void supabase.rpc("process_pos_drawer_event" as any, {
              p_register_id: registerId,
              p_shift_id: activeShift.id,
              p_reason: "auto_sale_kick",
              p_transaction_id: result.transaction.id,
              p_hardware_success: !!hwResult?.success,
              p_hardware_result: hwResult ?? null,
            } as any);
          }
        }
      } catch (drawerErr) {
        console.warn("[POS] drawer auto-kick failed (non-fatal):", drawerErr);
      }
      
      // Customer display — publish a domain event; saga writes to the
      // display (showComplete + scheduled reset). Removes the direct
      // updateCustomerDisplay / showDisplayComplete / resetDisplay calls
      // that previously raced with the cart-effect emit.
      if (currentBusiness?.id) {
        void domainEventBus.publish({
          type: 'pos.payment_completed',
          orgId: currentBusiness.id,
          branchId: shiftBranchId,
          sourceDocType: 'pos_transaction',
          sourceDocId: result.transaction.id,
          occurredAt: new Date().toISOString(),
          payload: {
            transactionId: result.transaction.id,
            transactionNumber: result.transactionNumber,
            total: cartData.total,
            change: result.change,
            customerName: cartData.customer_name ?? null,
            currency: currentBusiness?.base_currency,
          },
        });
      }

      
      // Post-transaction integrations (fire-and-forget, don't block UI)

      // 1. Loyalty accrual is now handled durably server-side by the
      //    outbox-dispatcher (`handlePosSaleCommitted` -> `apply_loyalty_accrual_for_sale`).
      //    Do NOT award points from the browser — the RPC is idempotent per
      //    pos_transaction_id and double-accrual would corrupt balances.

      
      // 2. Close table session after payment in restaurant mode
      // BUT only if there are no unpaid split bill portions remaining
      if (tableSessionId) {
        (async () => {
          try {
            // Check for active split bill with unpaid portions
            const { data: activeSplitBill } = await supabase
              .from("pos_split_bills")
              .select(`
                id,
                portions:pos_split_bill_portions(id, status)
              `)
              .eq("table_session_id", tableSessionId)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            const unpaidPortions = activeSplitBill?.portions?.filter(
              (p: any) => p.status === "pending"
            ) || [];

            if (unpaidPortions.length > 0) {
              // Don't close session — there are still unpaid portions
              toast.info(`${unpaidPortions.length} portion(s) still unpaid. Table remains open.`);
              // Update session to pending_payment status
              await supabase
                .from("pos_table_sessions")
                .update({ status: "pending_payment" as any })
                .eq("id", tableSessionId);
            } else {
              // All paid or no split — close the table session
              await supabase
                .from("pos_table_sessions")
                .update({
                  status: "available" as any,
                  closed_at: new Date().toISOString(),
                })
                .eq("id", tableSessionId);
              // Navigate back to floor plan if receipt won't auto-show
              if (!receiptSettings.auto_print_receipt) {
                navigate(`/pos/floor-plan/${registerId}?shift=${activeShift.id}`);
              }
            }
          } catch (err) {
            console.error("Close table session error:", err);
          }
        })();
      }
      
      // 3. Auto-transmit to eTIMS if enabled
      if (isEtimsEnabled && etimsSettings.etims_auto_transmit && !result.isOffline) {
        transmitToEtims.mutateAsync({
          transactionId: result.transaction.id,
          transactionNumber: result.transactionNumber,
          customerTin: undefined, // Could be added via customer record
          customerName: cartData.customer_name,
          items: capturedCartState.items.map(item => ({
            product_id: item.product_id || '',
            name: item.name,
            quantity: item.quantity,
            unit_price: item.unit_price,
            tax_amount: item.tax_amount,
            line_total: item.line_total,
          })),
          subtotal: cartData.subtotal,
          taxAmount: cartData.tax_amount,
          discountAmount: cartData.discount_amount,
          total: cartData.total,
        }).catch(err => console.error("eTIMS transmission error:", err));
      }
      
      // 4. Mark split portion as paid if applicable
      if (splitPortionToPay) {
        markPortionPaid.mutateAsync({
          portionId: splitPortionToPay.id,
          transactionId: result.transaction.id,
        }).catch(err => console.error("Split portion update error:", err));
      }
      
      // Stage X3 — always land on PostPaymentSurface after a successful
      // tender. `phase = "receipt"` gates the workspace mount; the
      // customer-facing "New Sale" button dispatches `newSale` which
      // returns the reducer to `ready`. Historically we did this via a
      // sibling `useState`, which meant the reducer could be stuck
      // on `tender` while `PostPaymentSurface` was on screen.
      // payment. The screen owns its own auto-print state machine
      // (driven by `posReceiptPolicy`), shows the cashier a confirmation
      // pane, exposes Reprint / Save PDF / Email / New Sale, and pushes
      // a "thank you / change" frame to the customer display. We no
      // longer silently fire-and-forget bytes to the printer.
      //
      // POS workstation Phase 1 hardening: also graduate the terminal
      // reducer to `receipt` deterministically. Previously the reducer
      // waited on `pos.payment_completed` from the domain-event bus,
      // which meant a slow or dropped event could leave `phase` stuck
      // on `tender` while `PostPaymentSurface` was on screen.
      terminalDispatch({
        kind: "op",
        op: "recordCompletion",
        transaction: {
          transactionId: result.transaction.id,
          receiptNumber: result.transactionNumber ?? null,
          total: cartData.total,
          paidAt: result.transaction.created_at,
          payload: null,
        },
      });
      // `showPostPayment` is now derived from `terminalState.phase === "receipt"`,
      // which the `recordCompletion` dispatch above already set. No sibling setter.
    } catch (error) {
      // Error handled by mutation - reopen payment dialog on failure
      setShowPayment(true);
      sound.play("error");
      // Reset customer display
      if (isDisplayConnected) {
        showDisplayMessage("Transaction failed - please try again");
      }
    } finally {
      setIsProcessingPayment(false);
    }
  };

  // Auto-evaluate promotions when cart changes.
  // IMPORTANT: only update state when the result actually changes, otherwise
  // every render re-allocates `[]` / a new discount object and — combined with
  // a fresh `cart.items` reference each render — produces an infinite render
  // loop that freezes the tab (especially noticeable on the post-payment
  // screen which subscribes to many sources).
  const lastPromoDiscountRef = useRef<number>(0);
  useEffect(() => {
    if (cart.items.length > 0 && promotions.length > 0) {
      const promoItems = cart.items.map(item => ({
        product_id: item.product_id || '',
        category_id: item.category_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        line_total: item.line_total,
      }));
      const result = evaluatePromotions(promoItems, cart.subtotal);
      const totalPromoDiscount = result.reduce((sum, p) => sum + p.discountAmount, 0);

      setAppliedPromotions(prev => {
        if (prev.length === result.length &&
            prev.every((p, i) => p.discountAmount === result[i].discountAmount && p.promotion.name === result[i].promotion.name)) {
          return prev;
        }
        return result;
      });

      if (totalPromoDiscount !== lastPromoDiscountRef.current) {
        lastPromoDiscountRef.current = totalPromoDiscount;
        if (totalPromoDiscount > 0) {
          cart.setCartDiscount({ type: "fixed", value: totalPromoDiscount });
        } else {
          cart.setCartDiscount(null);
        }
      }
    } else {
      setAppliedPromotions(prev => (prev.length === 0 ? prev : []));
      if (lastPromoDiscountRef.current !== 0) {
        lastPromoDiscountRef.current = 0;
        cart.setCartDiscount(null);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.items, cart.subtotal, promotions]);

  // ----------------------------------------------------------------------
  // Hooks below MUST stay above the loading / no-shift / lock-screen early
  // returns further down. Placing a `useMemo` after a conditional `return`
  // changes the hook count between renders as soon as the shift resolves
  // or the lock screen dismisses, which trips React's
  // "Rendered more hooks than during the previous render" invariant and
  // crashes the terminal into the POSErrorBoundary ("Call a supervisor").
  // See: rules-of-hooks — never call a hook after an early return.
  // ----------------------------------------------------------------------
  const saleActionBarCallbacks: SaleActionBarCallbacks = useMemo(() => ({
    onClearCart: () => {
      sound.play("cart_clear");
      cart.clearCart();
    },
    onSplitBill: () => setShowBillSplit(true),
    onTransferTable: () => setShowTableTransfer(true),
    onPrintBill: () => {
      setCompletedTransaction({
        id: "pro-forma",
        transaction_number: cart.draftTransactionNumber || "BILL",
        total_amount: cart.total,
        subtotal: cart.subtotal,
        tax_amount: cart.tax_amount,
        discount_amount: cart.discount_amount,
        created_at: new Date().toISOString(),
        customer_name: cart.customer?.name,
        items: cart.items.map(i => ({
          product_name: i.name,
          quantity: i.quantity,
          unit_price: i.unit_price,
          line_total: i.line_total,
          display_quantity: i.display_quantity ?? null,
          packaging_label: i.packaging_label ?? null,
        })),
        payments: [],
      });
      openSheet("sale.receiptPreview");
    },
    onHold: () => {
      if (activeShift && registerId && currentOrg) {
        holdTransaction.mutate({
          register_id: registerId,
          shift_id: activeShift.id,
          organization_id: currentOrg.id,
          cart: cart.cartState,
        });
        cart.clearCart();
        sound.play("hold");
      }
    },
    onRecallHeld: () => setShowHeld(true),
    onDiscount: () => setShowDiscount(true),
    onOpenPayment: () => setShowPayment(true),
  }), [
    sound,
    cart,
    activeShift,
    registerId,
    currentOrg,
    holdTransaction,
    setCompletedTransaction,
    openSheet,
    setShowHeld,
    setShowDiscount,
    setShowPayment,
  ]);

  /**
   * Mobile drawer variant of `saleActionBarCallbacks` — preserves the
   * three behavioural deltas the drawer had before the shared
   * component was adopted:
   *   1. Clear-with-confirm when there is an active table session and
   *      the cart has items (touchscreen safety-net for wait staff).
   *   2. Hold does NOT play the "hold" sound (drawer close already
   *      provides audible affordance and stacking a second SFX under
   *      the touch beep was too noisy in field testing).
   *   3. Every button closes the drawer — handled generically via
   *      `onAfterAction={() => setShowMobileCart(false)}` on the
   *      component itself, so callbacks below don't repeat it.
   */
  const mobileSaleActionBarCallbacks: SaleActionBarCallbacks = useMemo(() => ({
    ...saleActionBarCallbacks,
    onClearCart: () => {
      if (tableSessionId && cart.items.length > 0) {
        if (!window.confirm("Clear all items from this table order? This cannot be undone.")) return;
      }
      cart.clearCart();
    },
    onHold: () => {
      if (activeShift && registerId && currentOrg) {
        holdTransaction.mutate({
          register_id: registerId,
          shift_id: activeShift.id,
          organization_id: currentOrg.id,
          cart: cart.cartState,
        });
        cart.clearCart();
      }
    },
  }), [
    saleActionBarCallbacks,
    tableSessionId,
    cart,
    activeShift,
    registerId,
    currentOrg,
    holdTransaction,
  ]);

  if (isLoadingCurrentShift || isLoadingSession) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!activeShift) {
    return null;
  }

  // Show lock screen if required (also enforce require_cashier_pin from security settings)
  const showLock = shouldShowLockScreen || (securitySettings.require_cashier_pin && !activeSession);
  if (showLock) {
    return (
      <TerminalLockScreen
        registerName={activeShift.register?.register_name || 'Register'}
        cashiers={assignedCashiers}
        isLocked={isLocked}
        lockedCashierName={activeSession?.cashier?.display_name}
        onLogin={handleCashierLogin}
        onUnlock={handleUnlock}
        onManagerLogin={handleManagerLogin}
        isLoading={isLoggingIn || isUnlocking}
        isManagerLoading={isManagerLoggingIn}
        error={loginError}
        pinLength={securitySettings.pin_length}
      />
    );
  }

  // saleActionBarCallbacks / mobileSaleActionBarCallbacks are declared
  // ABOVE the loading + lock-screen early returns so their `useMemo`
  // calls do not change the hook count between renders.


  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden relative max-w-[1920px] mx-auto w-full">
      {/* Phase 1 (POS workstation): sync live shift + cart state into
          the terminal reducer so extracted workspaces (Phases 2-5) can
          react to phase changes via `useTerminalContext()`. Rendering
          the bridge here — inside the shell's provider — keeps the
          reducer authoritative without a top-down prop drill. */}
      <TerminalStateBridge
        hasActiveShift={!!activeShift}
        cartHasItems={cart.items.length > 0}
      />
      <ScanGhostTicker />
      {/* Processing Payment Overlay */}
      {isProcessingPayment && (
        <div className="absolute inset-0 z-[100] bg-background/80 backdrop-blur-sm flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 p-8 bg-card rounded-lg border shadow-lg">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
            <div className="text-center">
              <p className="text-lg font-semibold">Processing Payment</p>
              <p className="text-sm text-muted-foreground">Please wait...</p>
            </div>
          </div>
        </div>
      )}
      {/* Top Bar - Responsive */}
      <header className="h-auto min-h-[3.5rem] border-b bg-card flex flex-wrap items-center justify-between px-2 sm:px-4 py-2 gap-2">
        <div className="flex items-center gap-2 sm:gap-4">
          {tableSessionId ? (
            <Button variant="ghost" size="sm" className="px-2 sm:px-3" onClick={() => navigate(`/pos/floor-plan/${registerId}?shift=${activeShift.id}`)}>
              <UtensilsCrossed className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Tables</span>
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="px-2 sm:px-3" onClick={() => navigate("/pos")}>
              <X className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Exit</span>
            </Button>
          )}
          <Separator orientation="vertical" className="h-6 hidden sm:block" />
          <div className="flex items-center gap-1 sm:gap-2">
            {/* Online/Offline Status */}
            {isOnline ? (
              <Badge variant="outline" className="text-xs text-green-600 border-green-600 px-1.5 sm:px-2">
                <Wifi className="h-3 w-3 sm:mr-1" />
                <span className="hidden sm:inline">Online</span>
              </Badge>
            ) : (
              <Badge variant="destructive" className="text-xs px-1.5 sm:px-2">
                <WifiOff className="h-3 w-3 sm:mr-1" />
                <span className="hidden sm:inline">Offline</span> ({queueCount})
              </Badge>
            )}
            <span className="text-xs sm:text-sm font-medium hidden xs:inline">{activeShift.shift_number}</span>
            <Badge variant="outline" className="text-xs hidden md:inline-flex">
              {activeShift.register?.register_name}
            </Badge>
            {/* Cashier Display */}
            {activeSession?.cashier && (
              <Badge variant="secondary" className="text-xs hidden sm:inline-flex">
                <User className="h-3 w-3 mr-1" />
                {activeSession.cashier.display_name}
              </Badge>
            )}
            {/* Table Display (Restaurant Mode) */}
            {tableSessionId && (
              <Badge className="text-xs bg-orange-500 hover:bg-orange-600">
                <UtensilsCrossed className="h-3 w-3 mr-1" />
                Table {tableNumber || tableId?.slice(0, 4) || ""}
              </Badge>
            )}
            {/* Printer readiness — registry + workstation heartbeat, never a
                local transport probe (see receiptReadiness above). */}
            {receiptReadiness.isReady ? (
              <Badge
                variant="outline"
                title={receiptReadiness.message}
                className="text-xs text-green-600 border-green-600 px-1.5 sm:px-2 hidden sm:inline-flex"
              >
                <Printer className="h-3 w-3 sm:mr-1" />
                <span className="hidden md:inline">
                  {receiptReadiness.state === "degraded" ? "Printer (check)" : "Printer"}
                </span>
              </Badge>
            ) : receiptReadiness.state === "unknown" ? (
              <Badge
                variant="outline"
                title={receiptReadiness.message}
                className="text-xs text-yellow-600 border-yellow-600 px-1.5 sm:px-2 hidden sm:inline-flex"
              >
                <Printer className="h-3 w-3 animate-pulse sm:mr-1" />
                <span className="hidden md:inline">Checking…</span>
              </Badge>
            ) : (
              <Badge
                variant="outline"
                title={[receiptReadiness.message, receiptReadiness.detail]
                  .filter(Boolean)
                  .join(" — ")}
                className="text-xs text-muted-foreground px-1.5 sm:px-2 hidden sm:inline-flex"
              >
                <Printer className="h-3 w-3 sm:mr-1" />
                <span className="hidden md:inline">
                  {receiptReadiness.state === "no_device_bound"
                    ? "No printer"
                    : "Printer offline"}
                </span>
              </Badge>
            )}

          </div>
        </div>
        
        <div className="flex items-center gap-1 sm:gap-2">
          <Button variant="ghost" size="sm" className="px-2 sm:px-3 hidden sm:flex" onClick={() => setShowHistory(true)}>
            <Receipt className="h-4 w-4 sm:mr-2" />
            <span className="hidden md:inline">History</span>
          </Button>
          <Button variant="ghost" size="sm" className="px-2 sm:px-3 hidden sm:flex" onClick={() => setShowReturn(true)}>
            <RotateCcw className="h-4 w-4 sm:mr-2" />
            <span className="hidden md:inline">Return</span>
          </Button>
          <Button variant="ghost" size="sm" className="px-2 sm:px-3 hidden sm:flex" onClick={() => setShowCashDrawer(true)}>
            <Wallet className="h-4 w-4 sm:mr-2" />
            <span className="hidden md:inline">Drawer</span>
          </Button>
          {/* Phone-as-scanner pairing */}
          <Button
            variant={pairedScanners.length > 0 ? "secondary" : "ghost"}
            size="sm"
            className="px-2 sm:px-3 hidden sm:flex"
            onClick={() => setShowMobileScanner(true)}
            title="Use phone as scanner"
          >
            <Smartphone className="h-4 w-4 sm:mr-2" />
            <span className="hidden md:inline">
              {pairedScanners.length > 0 ? "Phone paired" : "Phone"}
            </span>
          </Button>
          {/* Customer Display Toggle */}
          <Button 
            variant={isDisplayConnected ? "secondary" : "ghost"} 
            size="sm" 
            className="px-2 sm:px-3 hidden sm:flex"
            onClick={() => isDisplayConnected ? closeCustomerDisplay() : openCustomerDisplay()}
            disabled={isDisplayLoading}
          >
            {isDisplayConnected ? <Monitor className="h-4 w-4 sm:mr-2" /> : <MonitorOff className="h-4 w-4 sm:mr-2" />}
            <span className="hidden md:inline">{isDisplayConnected ? 'Display On' : 'Display'}</span>
          </Button>

          {/* Sound Toggle (desktop) */}
          <div className="hidden sm:flex">
            <SoundToggleButton />
          </div>

          {/* Mobile Menu - More Options */}
          <div className="sm:hidden flex gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowHistory(true)}>
              <Receipt className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowReturn(true)}>
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowCashDrawer(true)}>
              <Wallet className="h-4 w-4" />
            </Button>
            <Button 
              variant={isDisplayConnected ? "secondary" : "ghost"} 
              size="icon" 
              className="h-8 w-8" 
              onClick={() => isDisplayConnected ? closeCustomerDisplay() : openCustomerDisplay()}
              disabled={isDisplayLoading}
            >
              {isDisplayConnected ? <Monitor className="h-4 w-4" /> : <MonitorOff className="h-4 w-4" />}
            </Button>
            <SoundToggleButton size="icon" />
          </div>
          
          <Separator orientation="vertical" className="h-6 hidden sm:block" />
          
          {/* Lock Terminal Button */}
          {activeSession && (
            <Button 
              variant="ghost" 
              size="sm" 
              className="px-2 sm:px-3"
              onClick={() => lockSession('Manual lock')}
            >
              <Lock className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Lock</span>
            </Button>
          )}
          
          <Button variant="outline" size="sm" className="px-2 sm:px-3" onClick={() => setShowCloseShift(true)}>
            <LogOut className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">End Shift</span>
          </Button>
        </div>
      </header>

      {/* Mobile Cart Toggle Button - Fixed at bottom on mobile */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-card p-2 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="secondary" className="text-sm shrink-0">
            {cart.items.length} items
          </Badge>
          <span className="font-bold truncate">{formatCurrency(cart.total)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant={cart.customer ? "secondary" : "ghost"}
            size="sm"
            className="px-2"
            onClick={() => setShowCustomer(true)}
            title={cart.customer ? cart.customer.name : "Add Customer"}
          >
            <User className="h-4 w-4" />
            {cart.customer && (
              <span className="ml-1 max-w-[4rem] truncate text-xs">{cart.customer.name.split(' ')[0]}</span>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowMobileCart(true)}
          >
            View Cart
          </Button>
          <Button
            size="sm"
            disabled={cart.items.length === 0}
            onClick={() => setShowPayment(true)}
          >
            Pay
          </Button>
        </div>
      </div>

      <SaleWorkspace
        cart={cart}
        sound={sound}
        registerId={registerId}
        activeShiftId={activeShift?.id ?? null}
        tableSessionId={tableSessionId}
        isTableSession={Boolean(tableSessionId)}
        canHold={Boolean(activeShift && registerId && currentOrg)}
        heldCount={heldCount}
        appliedPromotions={appliedPromotions}
        unknownScan={unknownScan}
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
        productsErrorMessage={productsErrorMessage}
        productsLoadedCount={productsLoadedCount}
        productsTotalCount={productsTotalCount}
        productsHasMore={productsHasMore}
        isFetchingMoreProducts={isFetchingMoreProducts}
        fetchMoreProducts={fetchMoreProducts}
        branchOnHand={branchOnHand}
        handleProductClick={handleProductClick}
        getDiscountedPrice={getDiscountedPrice}
        formatCurrency={formatCurrency}
        onScanRecoverySearch={(c) => {
          setSearchQuery(c);
          setUnknownScan(null);
        }}
        onScanRecoveryCreateProduct={(c) => {
          setUnknownScan(null);
          navigate(`/products?createWithCode=${encodeURIComponent(c)}`);
        }}
        onScanRecoveryDismiss={() => setUnknownScan(null)}
        saleActionBarCallbacks={saleActionBarCallbacks}
        onOpenCustomer={() => setShowCustomer(true)}
      />

      {/* Mobile Cart Drawer */}
      <Dialog open={showMobileCart} onOpenChange={setShowMobileCart}>
        <DialogContent className="h-[85vh] max-h-[85vh] w-[95vw] max-w-md flex flex-col p-0">
          <DialogHeader className="p-4 border-b">
            <DialogTitle className="flex items-center justify-between">
              <span>Cart ({cart.items.length} items)</span>
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Customer */}
            <div className="p-3 border-b">
              <Button
                variant="outline"
                className="w-full justify-start text-sm"
                onClick={() => {
                  setShowMobileCart(false);
                  setShowCustomer(true);
                }}
              >
                <User className="h-4 w-4 mr-2" />
                {cart.customer ? cart.customer.name : "Add Customer"}
              </Button>
            </div>

            {/* Cart Items */}
            <ScrollArea className="flex-1">
              <div className="p-3 space-y-2">
                {cart.items.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <div className="text-3xl mb-2">🛒</div>
                    <p className="text-sm">Cart is empty</p>
                  </div>
                ) : (
                  cart.items.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 p-2 rounded-lg border">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm line-clamp-1">{item.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatCurrency(item.unit_price)} each
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => cart.updateQuantity(item.id, item.quantity - 1)}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <span className="w-6 text-center text-sm font-medium">{item.quantity}</span>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => cart.updateQuantity(item.id, item.quantity + 1)}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="w-16 text-right">
                        <p className="text-sm font-semibold">{formatCurrency(item.line_total)}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        onClick={() => cart.removeItem(item.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>

            {/* Cart Summary */}
            <div className="border-t p-3 space-y-3">
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatCurrency(cart.subtotal)}</span>
                </div>
                {cart.discount_amount > 0 && (
                  <div className="flex justify-between text-green-600">
                    <span>Discount</span>
                    <span>-{formatCurrency(cart.discount_amount)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tax</span>
                  <span>{formatCurrency(cart.tax_amount)}</span>
                </div>
                <Separator />
                <div className="flex justify-between text-lg font-bold">
                  <span>Total</span>
                  <span>{formatCurrency(cart.total)}</span>
                </div>
              </div>

              {/* Action grid + Pay button — shared with the desktop
                  sale rail. `variant="mobile"` drops the quick-pay row
                  and the xl: size ramps; `onAfterAction` auto-closes
                  the drawer after any commit. Behaviour deltas
                  (confirm-on-clear for tableSession, silent hold) live
                  in `mobileSaleActionBarCallbacks`. */}
              <SaleActionBar
                cart={cart}
                isTableSession={!!tableSessionId}
                canHold={!!activeShift && !!registerId && !!currentOrg}
                heldCount={heldCount}
                formatCurrency={formatCurrency}
                callbacks={mobileSaleActionBarCallbacks}
                variant="mobile"
                onAfterAction={() => setShowMobileCart(false)}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialogs */}
      {registerId && activeShift?.id && showPayment && (
        <TenderWorkspace
          total={splitPortionToPay ? splitPortionToPay.amount : cart.total}
          tipAmount={tipAmount}
          onTipChange={tableSessionId ? setTipAmount : undefined}
          splitPortionLabel={splitPortionToPay ? `${splitPortionToPay.seat_label || `Portion ${splitPortionToPay.portion_number}`}` : undefined}
          hasCustomer={!!cart.customer?.id}
          registerPaymentMethods={registerPaymentMethods}
          appliedPromotions={appliedPromotions}
          sessionContext={{
            registerId,
            shiftId: activeShift.id,
            cashierId: activeShift.cashier_id ?? null,
            idempotencyKey:
              cart.isRestaurantMode && cart.transactionId
                ? cart.transactionId
                : paymentSessionIdempotencyKey,
          }}
          onComplete={handlePaymentComplete}
          onBack={() => setShowPayment(false)}
        />
      )}
      
      <CustomerSelectDialog
        open={showCustomer}
        onOpenChange={setShowCustomer}
        onSelect={(customer) => {
          cart.setCustomer(customer);
          setShowCustomer(false);
        }}
      />
      
      <CloseShiftDialog
        open={showCloseShift}
        onOpenChange={setShowCloseShift}
        shift={activeShift}
        onShiftClosed={() => navigate("/pos")}
      />

      {registerId && (
        <>
          {showHeld && (
            <HeldWorkspace
              registerId={registerId}
              onResume={(restoredCart) => {
                cart.restoreCart(restoredCart);
              }}
            />
          )}

          {activeShift && (
            <>
              <CashDrawerDialog
                open={showCashDrawer}
                onOpenChange={setShowCashDrawer}
                shiftId={activeShift.id}
                registerId={registerId}
                expectedCash={activeShift.expected_cash}
              />

              {/* Phase 3d — Return + History workspaces (replace the
                  legacy `<ReturnDialog>` / `<TransactionHistoryDialog>`
                  Radix Dialogs). Both are route-owned surfaces gated on
                  `terminalState.phase`; exit dispatches `closeSide` on
                  the reducer so the previous phase is restored. */}
              <ReturnWorkspace
                registerId={registerId}
                shiftId={activeShift.id}
              />

              <HistoryWorkspace
                shiftId={activeShift.id}
                registerId={registerId}
              />
            </>
          )}

          <DiscountDialog
            open={showDiscount}
            onOpenChange={setShowDiscount}
            subtotal={cart.subtotal}
            registerId={registerId}
            activeSession={activeSession}
            onApply={(type, value) => {
              cart.setCartDiscount({ type, value });
              sound.play("discount_applied");
              setShowDiscount(false);
            }}
          />
        </>
      )}

      {/* Pro-forma Print Bill preview — sale-workspace sheet, opened via
          `openSheet("sale.receiptPreview")` and auto-dismissed on phase
          change by the reducer. Replaces the retired
          `ReceiptPreviewDialog` page-dialog mount. */}
      <ReceiptPreviewSheet
        transaction={completedTransaction}
        onEmail={() => setShowEmailReceipt(true)}
      />


      {/* Phase 3c — Receipt workspace (replaces the ad-hoc
          <PostPaymentSurface> mount). Route-owned surface for
          `terminalState.phase === "receipt"`; `newSale` dispatch is
          handled inside the workspace itself, so the reducer — not a
          sibling useState — decides when the terminal returns to
          `ready`. */}
      <ReceiptWorkspace
        transaction={completedTransaction}
        policy={postPaymentPolicy}
        onEmail={() => setShowEmailReceipt(true)}
        onNewSale={() => {
          setCompletedTransaction(null);
        }}
      />

      {/* Receipt Email Dialog (unified SendDocumentDialog) */}
      {completedTransaction && (
        <SendDocumentDialog
          open={showEmailReceipt}
          onOpenChange={setShowEmailReceipt}
          document={{
            documentType: "pos_receipt",
            documentId: completedTransaction.id,
            documentNumber: completedTransaction.transaction_number,
            recipientName: completedTransaction.customer_name,
            total: completedTransaction.total_amount,
          }}
        />
      )}

      {/* Modifier Selection Dialog (Restaurant Mode) */}
      {pendingProduct && (
        <ModifierSelectionDialog
          open={showModifiers}
          onOpenChange={(open) => {
            setShowModifiers(open);
            if (!open) setPendingProduct(null);
          }}
          productId={pendingProduct.id}
          productName={pendingProduct.name}
          basePrice={getDiscountedPrice(pendingProduct.id, pendingProduct.selling_price).price}
          onConfirm={handleModifierConfirm}
        />
      )}

      {/* Multi-unit (Box / Strip / Each) selection dialog */}
      {unitSelectProduct && (
        <POSUnitSelectDialog
          open={showUnitSelect}
          onOpenChange={(open) => {
            setShowUnitSelect(open);
            if (!open) setUnitSelectProduct(null);
          }}
          productId={unitSelectProduct.id}
          productName={unitSelectProduct.name}
          baseUomId={unitSelectProduct.base_uom_id ?? null}
          basePrice={getDiscountedPrice(unitSelectProduct.id, unitSelectProduct.selling_price).price}
          formatCurrency={formatCurrency}
          onConfirm={handleUnitSelectConfirm}
        />
      )}

      {/* Bill Split Dialog (Restaurant Mode) */}
      {tableSessionId && (
        <BillSplitDialog
          open={showBillSplit}
          onOpenChange={setShowBillSplit}
          tableSessionId={tableSessionId}
          totalAmount={cart.total}
          items={cart.items.map(i => ({
            id: i.id,
            name: i.name,
            quantity: i.quantity,
            total: i.line_total,
          }))}
          onPayPortion={(portionId, amount) => {
            const portion = splitBill?.portions?.find((p: any) => p.id === portionId);
            if (portion) {
              setSplitPortionToPay(portion);
              setShowBillSplit(false);
              setShowPayment(true);
            }
          }}
        />
      )}

      {/* Table Transfer Dialog (Restaurant Mode) */}
      {tableSessionId && (
        <TableTransferDialog
          open={showTableTransfer}
          onOpenChange={setShowTableTransfer}
          sourceSession={{
            id: tableSessionId,
            tableName: tableNumber ? `Table ${tableNumber}` : "Current Table",
            items: cart.items.map(i => ({
              id: i.id,
              name: i.name,
              quantity: i.quantity,
              total: i.line_total,
            })),
          }}
          availableSessions={transferAvailableSessions}
          availableTables={transferAvailableTables}
          onComplete={() => {
            navigate(`/pos/floor-plan/${registerId}?shift=${activeShift?.id}`);
          }}
        />
      )}
      <KeyboardShortcutsOverlay />
      {registerId && (
        <MobileScannerDialog
          open={showMobileScanner}
          onOpenChange={setShowMobileScanner}
          registerId={registerId}
          connectedDevices={pairedScanners}
          lastScanByDevice={pairedScannerLastScans}
          onRevoke={revokePairedScanner}
        />
      )}
    </div>
  );
}
