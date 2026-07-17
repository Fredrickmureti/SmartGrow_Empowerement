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
import { usePOSCartAdapter } from "@/hooks/pos/usePOSCartAdapter";
import { usePOSShifts } from "@/hooks/pos/usePOSShifts";
import { usePOSTransactionOffline } from "@/hooks/pos/usePOSTransactionOffline";
import { usePOSHeldTransactions } from "@/hooks/pos/usePOSHeldTransactions";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { usePOSLoyalty } from "@/hooks/pos/usePOSLoyalty";
import { usePOSAgeVerification } from "@/hooks/pos/usePOSAgeVerification";
import { usePOSOffline } from "@/hooks/pos/usePOSOffline";
import { usePOSSessionsOffline } from "@/hooks/pos/usePOSSessionsOffline";
import { useHardwareProxy } from "@/hooks/hardware/useHardwareProxy";
import { useCustomerDisplay } from "@/hooks/pos/useCustomerDisplay";
import { domainEventBus } from "@/services/events/domainEventBus";
import { usePOSPromotions } from "@/hooks/pos/usePOSPromotions";
import { useHappyHour } from "@/hooks/pos/useHappyHour";
import { useKitchenDisplay } from "@/hooks/pos/useKitchenDisplay";
import { useModifiers, type SelectedModifier } from "@/hooks/pos/useModifiers";
import { usePOSEtims } from "@/hooks/pos/usePOSEtims";
import { useBillSplitting, type SplitBillPortion } from "@/hooks/pos/useBillSplitting";
import { usePOSSecuritySettings } from "@/hooks/pos/usePOSSecuritySettings";
import { usePOSSecurityAudit } from "@/hooks/pos/usePOSSecurityAudit";
import { CloseShiftDialog } from "@/components/pos/CloseShiftDialog";
import { PaymentDialog } from "@/components/pos/PaymentDialog";
import { usePOSRegisters } from "@/hooks/pos/usePOSRegisters";
import { CustomerSelectDialog } from "@/components/pos/CustomerSelectDialog";
import { HeldTransactionsDialog } from "@/components/pos/HeldTransactionsDialog";
import { HeldOrdersBar } from "@/components/pos/HeldOrdersBar";
import { KeyboardShortcutsOverlay } from "@/components/pos/KeyboardShortcutsOverlay";
import { useDrawerPolicy } from "@/hooks/pos/useDrawerPolicy";
import { parseScanPayload } from "@/services/pos/parseBarcode";
import { interpretScan } from "@/lib/gs1/useGs1Scanner";
// useScanCapture is mounted globally in AuthenticatedShell
import { useResolveBarcode } from "@/hooks/pos/useResolveBarcode";
import { scanBus } from "@/services/pos/scanBus";
import { scanRouter } from "@/services/pos/scanRouter";
import { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";
import { ScanGhostTicker } from "@/components/pos/ScanGhostTicker";
import { ScanRecoveryBanner } from "@/components/pos/ScanRecoveryBanner";
import { MobileScannerDialog } from "@/components/pos/MobileScannerDialog";
import { usePOSScannerChannel } from "@/hooks/pos/usePOSScannerChannel";
import { useScannerScopeMode } from "@/hooks/scanner/useScannerScopePolicy";
import { CashDrawerDialog } from "@/components/pos/CashDrawerDialog";
import { DiscountDialog } from "@/components/pos/DiscountDialog";
import { ReturnDialog } from "@/components/pos/ReturnDialog";
import { TransactionHistoryDialog } from "@/components/pos/TransactionHistoryDialog";
import { ReceiptPreviewDialog } from "@/components/pos/ReceiptPreviewDialog";
import { PostPaymentScreen } from "@/components/pos/PostPaymentScreen";
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
import { useResolvedPrintPolicyWithDevice } from "@/hooks/useDocumentPrintPolicies";
import { useCurrency } from "@/hooks/useCurrency";
import { useTableSessions } from "@/hooks/pos/useTableSessions";
import { useFloorPlan } from "@/hooks/pos/useFloorPlan";
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
    filteredProducts, 
    categories, 
    isLoading: productsLoading,
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
  
  const cart = usePOSCartAdapter({ 
    tableSessionId: tableSessionId || null, 
    registerId: registerId || "", 
    shiftId: activeShift?.id || "",
    tableNumber: tableNumber || undefined,
  });
  const { completeTransaction } = usePOSTransactionOffline();
  const sound = usePOSSound();
  const { heldCount, holdTransaction } = usePOSHeldTransactions(registerId);
  const { receiptSettings } = usePOSSettings();
  const { program: loyaltyProgram, calculatePoints, fetchCustomerLoyalty, earnPoints } = usePOSLoyalty();
  const { isVerified: ageVerified, getRestrictedItems, verify: verifyAge, reset: resetAgeVerification, needsVerification } = usePOSAgeVerification();
  const { isOnline, queueCount } = usePOSOffline();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // Stage W6 (ADR-0008) — resolved per-tenant print policy for POS receipts.
  // Wave 10 — also resolves the bound device so PostPaymentScreen can show
  // operators which physical printer the receipt will land on (and the
  // dispatch hook can prefer device id over role lookup).
  const {
    policy: posReceiptPolicy,
    device: posReceiptDevice,
  } = useResolvedPrintPolicyWithDevice(
    currentBusiness?.id,
    shiftBranchId,
    "pos_receipt",
  );
  // Stable reference for PostPaymentScreen so its effects don't re-fire each render.
  const postPaymentPolicy = useMemo(() => ({
    auto_print: !!posReceiptPolicy.auto_print,
    render_mode: (posReceiptPolicy.render_mode === "escpos" ? "escpos" : "pdf") as "pdf" | "escpos",
    paper_format: posReceiptPolicy.paper_format as
      | "58mm" | "80mm" | "a4" | "a5" | "letter",
    device_id: posReceiptDevice?.id ?? null,
    device_label: posReceiptDevice?.display_name
      ?? (posReceiptDevice ? `${posReceiptDevice.role} (${posReceiptDevice.transport})` : null),
  }), [posReceiptPolicy.auto_print, posReceiptPolicy.render_mode, posReceiptPolicy.paper_format, posReceiptDevice?.id, posReceiptDevice?.display_name, posReceiptDevice?.role, posReceiptDevice?.transport]);
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  // Set of product IDs that have at least one packaging level defined. Used to
  // decide whether tapping a tile opens the unit picker (Box/Strip/Each) or
  // adds the base unit directly. One lightweight query per business.
  const { data: packagedProductIds } = useQuery<Set<string>>({
    queryKey: ["pos-packaged-product-ids", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_packaging")
        .select("product_id")
        .eq("business_id", currentBusiness!.id);
      if (error) throw error;
      return new Set<string>((data ?? []).map((r) => r.product_id));
    },
  });
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
  const { splitBill, createSplitBill, markPortionPaid, getUnpaidPortions, calculateEqualSplit } = useBillSplitting(tableSessionId || undefined);
  
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
  
  // Hardware — proxy-based device management (replaces old direct-service approach)
  const { printerStatus, isConnecting: isPrinterAutoConnecting, openDrawer: openDrawerHw, printRawBytes } = useHardwareProxy(registerId);
  const hardwareStatus = { printer: printerStatus(), cashDrawer: 'disconnected' as const, scale: 'disconnected' as const };
  
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
  const [showPayment, setShowPayment] = useState(false);
  const [showCustomer, setShowCustomer] = useState(false);
  const [showCloseShift, setShowCloseShift] = useState(false);
  const [showHeld, setShowHeld] = useState(false);
  const [showCashDrawer, setShowCashDrawer] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  const [showReturn, setShowReturn] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  // Stage X3 — full post-payment success screen (separate from the
  // pro-forma `showReceipt` flow, which keeps using ReceiptPreviewDialog).
  const [showPostPayment, setShowPostPayment] = useState(false);
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
  const [completedTransaction, setCompletedTransaction] = useState<{
    id: string;
    transaction_number: string;
    total_amount: number;
    subtotal: number;
    tax_amount: number;
    discount_amount: number;
    created_at: string;
    customer_name?: string;
    cashier_name?: string;
    register_id?: string;
    invoice_id?: string | null;
    invoice_number?: string | null;
    etims_cu_number?: string | null;
    etims_qr_data?: string | null;
    payment_method?: string;
    is_voided?: boolean;
    is_refund?: boolean;
    original_transaction_number?: string | null;
    items: Array<{
      product_name: string;
      sku?: string;
      quantity: number;
      unit_price: number;
      discount_amount?: number;
      line_total: number;
    }>;
    payments: Array<{
      payment_method: string;
      amount: number;
      tendered_amount?: number;
      change_given?: number;
      reference?: string;
    }>;
  } | null>(null);
  
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
    async (code: string, qtyMultiplier: number, source: "keyboard" | "manual" | "camera" | "serial") => {
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
        const reason = offline ? "Offline — code not cached" : "Unknown barcode";
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
      category_id: product.category || undefined,
      tax_rate_id: product.tax_rate_id || undefined,
      tax_rate_name: product.tax_rate_name || undefined,
      etims_tax_code: product.etims_tax_code || undefined,
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
        category_id: product.category || undefined,
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
      category_id: pendingProduct.category || undefined,
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

  const handlePaymentComplete = async (payments: Array<{ method: string; amount: number; tendered_amount?: number; change_given?: number; reference?: string }>) => {
    if (!activeShift || !registerId) return;

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

      // Restaurant mode: finalize existing draft transaction
      if (cart.isRestaurantMode && cart.transactionId) {
        const { data: rpcResult, error: rpcErr } = await supabase.rpc(
          "finalize_table_order" as any,
          {
            p_transaction_id: cart.transactionId,
            p_payments: payments.map(p => {
              const method = p.method === "mpesa" ? "mobile_money" : p.method;
              const tendered = p.tendered_amount ?? p.amount;
              const change = p.change_given ?? Math.max(0, tendered - p.amount);
              return {
                payment_method: method,
                amount: p.amount,
                tendered_amount: tendered,
                change_given: method === "cash" ? change : 0,
                reference: p.reference || null,
              };
            }),
            p_tip_amount: tipAmount || 0,
            p_created_by: user?.id || null,
          }
        );

        if (rpcErr) throw rpcErr;
        const res = rpcResult as any;
        if (!res?.success) {
          const errMsg = res?.error === "insufficient_stock"
            ? `Insufficient stock for: ${(res.details as any[]).map((d: any) => d.product_name).join(", ")}`
            : res?.error || "Transaction finalization failed";
          throw new Error(errMsg);
        }

        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
        result = {
          transaction: { id: res.transaction_id, created_at: new Date().toISOString() },
          transactionNumber: res.transaction_number,
          change: res.change ?? Math.max(0, totalPaid - cart.total),
        };
      } else {
        // Retail mode: create new transaction via RPC
        result = await completeTransaction.mutateAsync({
          register_id: registerId,
          shift_id: activeShift.id,
          business_id: currentBusiness?.id,
          cart: cart.cartState,
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
            };
          }),
          table_session_id: tableSessionId || undefined,
          tip_amount: tipAmount || 0,
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
      
      // 1. Earn loyalty points if customer is attached
      if (capturedCustomer?.id && loyaltyProgram) {
        earnPoints({
          contactId: capturedCustomer.id,
          transactionId: result.transaction.id,
          amount: cartData.total,
        }).catch(err => console.error("Loyalty points error:", err));
      }
      
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
      
      // Stage X3 — always land on PostPaymentScreen after a successful
      // payment. The screen owns its own auto-print state machine
      // (driven by `posReceiptPolicy`), shows the cashier a confirmation
      // pane, exposes Reprint / Save PDF / Email / New Sale, and pushes
      // a "thank you / change" frame to the customer display. We no
      // longer silently fire-and-forget bytes to the printer.
      setShowPostPayment(true);
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

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden relative max-w-[1920px] mx-auto w-full">
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
            {/* Printer Status */}
            {hardwareStatus.printer === 'connected' ? (
              <Badge variant="outline" className="text-xs text-green-600 border-green-600 px-1.5 sm:px-2 hidden sm:inline-flex">
                <Printer className="h-3 w-3 sm:mr-1" />
                <span className="hidden md:inline">Printer</span>
              </Badge>
            ) : isPrinterAutoConnecting ? (
              <Badge variant="outline" className="text-xs text-yellow-600 border-yellow-600 px-1.5 sm:px-2 hidden sm:inline-flex">
                <Printer className="h-3 w-3 animate-pulse sm:mr-1" />
                <span className="hidden md:inline">Connecting...</span>
              </Badge>
            ) : hardwareStatus.printer === 'disconnected' ? (
              <Badge variant="outline" className="text-xs text-muted-foreground px-1.5 sm:px-2 hidden sm:inline-flex">
                <Printer className="h-3 w-3 sm:mr-1" />
                <span className="hidden md:inline">Disconnected</span>
              </Badge>
            ) : null}
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

      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Products */}
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
            <div className={cn(
              "p-2 sm:p-4",
              viewMode === "grid" 
                ? "grid grid-cols-2 xs:grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2 sm:gap-3"
                : "space-y-2"
            )}>
              {productsLoading ? (
                Array.from({ length: 12 }).map((_, i) => (
                  <div
                    key={i}
                    className={cn(
                      "animate-pulse bg-muted rounded-lg",
                      viewMode === "grid" ? "aspect-square" : "h-16"
                    )}
                  />
                ))
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
                    <span className="text-xs sm:text-sm font-medium line-clamp-2 leading-tight">{product.name}</span>
                    {(() => {
                      const hh = getDiscountedPrice(product.id, product.selling_price);
                      if (hh.happyHour) {
                        return (
                          <div className="flex flex-col items-center mt-0.5">
                            <span className="text-[10px] line-through text-muted-foreground">{formatCurrency(product.selling_price)}</span>
                            <span className="text-xs sm:text-sm text-primary font-semibold">{formatCurrency(hh.price)}</span>
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
                    {product.track_inventory && (branchOnHand.get(product.id) ?? 0) <= (product.reorder_level || 0) && (
                      <Badge variant="destructive" className="text-[10px] sm:text-xs mt-0.5 sm:mt-1 px-1">Low</Badge>
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

        {/* Right Panel - Cart (Desktop) */}
        <div className="hidden lg:flex w-80 xl:w-96 flex-col bg-card border-l">
          <ScanRecoveryBanner
            code={unknownScan?.code ?? null}
            reason={unknownScan?.reason}
            onSearch={(c) => {
              setSearchQuery(c);
              setUnknownScan(null);
            }}
            onCreateProduct={(c) => {
              setUnknownScan(null);
              navigate(`/products?createWithCode=${encodeURIComponent(c)}`);
            }}
            onDismiss={() => setUnknownScan(null)}
          />
          {/* Stage D: persistent held-orders strip */}
          {registerId && activeShift && (
            <HeldOrdersBar
              registerId={registerId}
              shiftId={activeShift.id}
              hasActiveCart={cart.items.length > 0}
              onRecall={(restoredCart) => cart.restoreCart(restoredCart)}
            />
          )}
          {/* Customer */}
          <div className="p-3 xl:p-4 border-b">
            <Button
              variant="outline"
              className="w-full justify-start text-sm"
              onClick={() => setShowCustomer(true)}
            >
              <User className="h-4 w-4 mr-2" />
              {cart.customer ? cart.customer.name : "Add Customer"}
            </Button>
          </div>

          {/* Cart Items */}
          <ScrollArea className="flex-1">
            <div className="p-3 xl:p-4 space-y-2">
              {cart.items.length === 0 ? (
                <div className="text-center py-8 xl:py-12 text-muted-foreground">
                  <div className="text-3xl xl:text-4xl mb-2">🛒</div>
                  <p className="text-sm">Cart is empty</p>
                  <p className="text-xs">Click products to add them</p>
                </div>
              ) : (
                cart.items.map((item) => (
                  <div key={item.id} className="flex flex-col gap-2 p-2 xl:p-3 rounded-lg border">
                    {/* Row 1: product name (full width, may wrap up to 2 lines) */}
                    <p className="font-medium text-xs xl:text-sm leading-snug line-clamp-2 break-words">
                      {item.name}
                    </p>
                    {/* Row 2: qty controls (left) · unit price + line total (right, never truncated) */}
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1 xl:gap-2 shrink-0">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-7 w-7 xl:h-8 xl:w-8"
                          onClick={() => {
                            if (item.quantity - 1 <= 0) sound.play("cart_remove");
                            cart.updateQuantity(item.id, item.quantity - 1);
                          }}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <span className="min-w-[1.5rem] xl:min-w-[2rem] text-center text-sm font-medium tabular-nums">
                          {item.quantity}
                        </span>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-7 w-7 xl:h-8 xl:w-8"
                          onClick={() => cart.updateQuantity(item.id, item.quantity + 1)}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="flex flex-col items-end leading-tight ml-auto">
                        <p className="text-[11px] xl:text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                          {formatCurrency(item.unit_price)} × {item.quantity}
                        </p>
                        <p className="text-sm xl:text-base font-semibold tabular-nums whitespace-nowrap">
                          {formatCurrency(item.line_total)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>

          {/* Cart Summary */}
          <div className="border-t p-3 xl:p-4 space-y-3 xl:space-y-4">
            <div className="space-y-1.5 xl:space-y-2 text-sm">
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
              {appliedPromotions.length > 0 && appliedPromotions.map((promo, i) => (
                <div key={i} className="flex justify-between text-xs text-green-600">
                  <span className="flex items-center gap-1"><Sparkles className="h-3 w-3" />{promo.promotion.name}</span>
                  <span>-{formatCurrency(promo.discountAmount)}</span>
                </div>
              ))}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span>{formatCurrency(cart.tax_amount)}</span>
              </div>
              <Separator />
              <div className="flex justify-between text-base xl:text-lg font-bold">
                <span>Total</span>
                <span>{formatCurrency(cart.total)}</span>
              </div>
            </div>

            {/* Action Buttons */}
            <div className={cn("grid gap-1.5 xl:gap-2", tableSessionId ? "grid-cols-5" : "grid-cols-4")}>
              <Button 
                variant="outline" 
                className="flex-col h-auto py-2 xl:py-3 px-1"
                onClick={() => {
                  sound.play("cart_clear");
                  cart.clearCart();
                }}
                disabled={cart.items.length === 0}
              >
                <Trash2 className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
                <span className="text-[10px] xl:text-xs">Clear</span>
              </Button>
              {tableSessionId ? (
                <>
                  <Button 
                    variant="outline" 
                    className="flex-col h-auto py-2 xl:py-3 px-1"
                    disabled={cart.items.length === 0}
                    onClick={() => setShowBillSplit(true)}
                  >
                    <Split className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
                    <span className="text-[10px] xl:text-xs">Split</span>
                  </Button>
                  <Button 
                    variant="outline" 
                    className="flex-col h-auto py-2 xl:py-3 px-1"
                    onClick={() => setShowTableTransfer(true)}
                  >
                    <RotateCcw className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
                    <span className="text-[10px] xl:text-xs">Transfer</span>
                  </Button>
                  <Button 
                    variant="outline" 
                    className="flex-col h-auto py-2 xl:py-3 px-1"
                    disabled={cart.items.length === 0}
                    onClick={() => {
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
                      setShowReceipt(true);
                    }}
                  >
                    <Receipt className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
                    <span className="text-[10px] xl:text-xs">Bill</span>
                  </Button>
                </>
              ) : (
                <>
                  <Button 
                    variant="outline" 
                    className="flex-col h-auto py-2 xl:py-3 px-1 relative"
                    disabled={cart.items.length === 0}
                    onClick={() => {
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
                    }}
                  >
                    <Pause className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
                    <span className="text-[10px] xl:text-xs">Hold</span>
                  </Button>
                  <Button 
                    variant="outline" 
                    className="flex-col h-auto py-2 xl:py-3 px-1 relative"
                    onClick={() => setShowHeld(true)}
                  >
                    <Play className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
                    <span className="text-[10px] xl:text-xs">Recall</span>
                    {heldCount > 0 && (
                      <Badge className="absolute -top-1 -right-1 h-4 w-4 xl:h-5 xl:w-5 p-0 text-[10px] xl:text-xs">
                        {heldCount}
                      </Badge>
                    )}
                  </Button>
                </>
              )}
              <Button 
                variant="outline" 
                className="flex-col h-auto py-2 xl:py-3 px-1"
                disabled={cart.items.length === 0}
                onClick={() => setShowDiscount(true)}
              >
                <Tag className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
                <span className="text-[10px] xl:text-xs">Discount</span>
              </Button>
            </div>

            {/* Quick Payment Buttons */}
            {cart.items.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <Button 
                  variant="secondary" 
                  className="h-10 xl:h-12 text-sm"
                  onClick={() => setShowPayment(true)}
                >
                  <Banknote className="h-4 w-4 xl:h-5 xl:w-5 mr-1 xl:mr-2" />
                  Cash
                </Button>
                <Button 
                  variant="secondary" 
                  className="h-10 xl:h-12 text-sm"
                  onClick={() => setShowPayment(true)}
                >
                  <CreditCard className="h-4 w-4 xl:h-5 xl:w-5 mr-1 xl:mr-2" />
                  Card
                </Button>
              </div>
            )}
            
            {/* Pay Button */}
            <Button 
              className="w-full h-12 xl:h-14 text-base xl:text-lg"
              disabled={cart.items.length === 0}
              onClick={() => setShowPayment(true)}
            >
              <CreditCard className="h-4 w-4 xl:h-5 xl:w-5 mr-2" />
              Pay {formatCurrency(cart.total)}
            </Button>
          </div>
        </div>
      </div>

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

              {/* Action Buttons */}
              <div className={cn("grid gap-1.5", tableSessionId ? "grid-cols-5" : "grid-cols-4")}>
                <Button 
                  variant="outline" 
                  className="flex-col h-auto py-2 px-1"
                  onClick={() => {
                    if (tableSessionId && cart.items.length > 0) {
                      if (!window.confirm("Clear all items from this table order? This cannot be undone.")) return;
                    }
                    cart.clearCart();
                  }}
                  disabled={cart.items.length === 0}
                >
                  <Trash2 className="h-4 w-4 mb-0.5" />
                  <span className="text-[10px]">Clear</span>
                </Button>
                {tableSessionId ? (
                  <>
                    <Button 
                      variant="outline" 
                      className="flex-col h-auto py-2 px-1"
                      disabled={cart.items.length === 0}
                      onClick={() => { setShowMobileCart(false); setShowBillSplit(true); }}
                    >
                      <Split className="h-4 w-4 mb-0.5" />
                      <span className="text-[10px]">Split</span>
                    </Button>
                    <Button 
                      variant="outline" 
                      className="flex-col h-auto py-2 px-1"
                      onClick={() => { setShowMobileCart(false); setShowTableTransfer(true); }}
                    >
                      <RotateCcw className="h-4 w-4 mb-0.5" />
                      <span className="text-[10px]">Transfer</span>
                    </Button>
                    <Button 
                      variant="outline" 
                      className="flex-col h-auto py-2 px-1"
                      disabled={cart.items.length === 0}
                      onClick={() => {
                        // Print Bill (pro-forma receipt) without payment
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
                          payments: [], // No payments yet — pro-forma
                        });
                        setShowMobileCart(false);
                        setShowReceipt(true);
                      }}
                    >
                      <Receipt className="h-4 w-4 mb-0.5" />
                      <span className="text-[10px]">Print Bill</span>
                    </Button>
                  </>
                ) : (
                  <>
                    <Button 
                      variant="outline" 
                      className="flex-col h-auto py-2 px-1 relative"
                      disabled={cart.items.length === 0}
                      onClick={() => {
                        if (activeShift && registerId && currentOrg) {
                          holdTransaction.mutate({
                            register_id: registerId,
                            shift_id: activeShift.id,
                            organization_id: currentOrg.id,
                            cart: cart.cartState,
                          });
                          cart.clearCart();
                          setShowMobileCart(false);
                        }
                      }}
                    >
                      <Pause className="h-4 w-4 mb-0.5" />
                      <span className="text-[10px]">Hold</span>
                    </Button>
                    <Button 
                      variant="outline" 
                      className="flex-col h-auto py-2 px-1 relative"
                      onClick={() => {
                        setShowMobileCart(false);
                        setShowHeld(true);
                      }}
                    >
                      <Play className="h-4 w-4 mb-0.5" />
                      <span className="text-[10px]">Recall</span>
                      {heldCount > 0 && (
                        <Badge className="absolute -top-1 -right-1 h-4 w-4 p-0 text-[10px]">
                          {heldCount}
                        </Badge>
                      )}
                    </Button>
                  </>
                )}
                <Button 
                  variant="outline" 
                  className="flex-col h-auto py-2 px-1"
                  disabled={cart.items.length === 0}
                  onClick={() => {
                    setShowMobileCart(false);
                    setShowDiscount(true);
                  }}
                >
                  <Tag className="h-4 w-4 mb-0.5" />
                  <span className="text-[10px]">Discount</span>
                </Button>
              </div>

              {/* Pay Button */}
              <Button 
                className="w-full h-12 text-lg"
                disabled={cart.items.length === 0}
                onClick={() => {
                  setShowMobileCart(false);
                  setShowPayment(true);
                }}
              >
                <CreditCard className="h-5 w-5 mr-2" />
                Pay {formatCurrency(cart.total)}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialogs */}
      <PaymentDialog
        open={showPayment}
        onOpenChange={setShowPayment}
        total={splitPortionToPay ? splitPortionToPay.amount : cart.total}
        tipAmount={tipAmount}
        onTipChange={tableSessionId ? setTipAmount : undefined}
        splitPortionLabel={splitPortionToPay ? `${splitPortionToPay.seat_label || `Portion ${splitPortionToPay.portion_number}`}` : undefined}
        hasCustomer={!!cart.customer?.id}
        registerPaymentMethods={registerPaymentMethods}
        onComplete={handlePaymentComplete}
      />
      
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
          <HeldTransactionsDialog
            open={showHeld}
            onOpenChange={setShowHeld}
            registerId={registerId}
            onResume={(restoredCart) => {
              cart.restoreCart(restoredCart);
              setShowHeld(false);
            }}
          />

          {activeShift && (
            <>
              <CashDrawerDialog
                open={showCashDrawer}
                onOpenChange={setShowCashDrawer}
                shiftId={activeShift.id}
                registerId={registerId}
                expectedCash={activeShift.expected_cash}
              />

              <ReturnDialog
                open={showReturn}
                onOpenChange={setShowReturn}
                registerId={registerId}
                shiftId={activeShift.id}
              />

              <TransactionHistoryDialog
                open={showHistory}
                onOpenChange={setShowHistory}
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

      {/* Receipt Preview Dialog */}
      <ReceiptPreviewDialog
        open={showReceipt}
        onOpenChange={setShowReceipt}
        transaction={completedTransaction}
        onPrint={() => {
          // Print handled by dialog
        }}
        onEmail={() => {
          setShowEmailReceipt(true);
        }}
      />

      {/* Stage X3 — Post-payment success screen (replaces popup-only
          success path). Shown after `completeTransaction` succeeds; owns
          auto-print, reprint, save PDF, email, and "new sale" hotkeys. */}
      <PostPaymentScreen
        open={showPostPayment}
        transaction={completedTransaction}
        policy={postPaymentPolicy}
        onEmail={() => setShowEmailReceipt(true)}
        onNewSale={() => {
          setShowPostPayment(false);
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
