import { useState, useEffect, useMemo, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Link as RouterLink } from "react-router-dom";
import {
  Banknote,
  CreditCard,
  Smartphone,
  Building,
  FileText,
  Wallet,
  Plus,
  Trash2,
  CheckCircle,
  Loader2,
} from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { usePaymentProviders } from "@/hooks/usePaymentProviders";
import { resolvePaymentMethods, countReady } from "@/lib/pos/paymentMethodResolver";
import { cn } from "@/lib/utils";
import { MpesaPaymentModal } from "./MpesaPaymentModal";
import { MpesaC2BLookupModal } from "./MpesaC2BLookupModal";
import { CardPaymentModal, type CardAuthPayload } from "./CardPaymentModal";
import { Search } from "lucide-react";
import { toast } from "sonner";
import {
  usePaymentSession,
  type PaymentSessionTenderRow,
} from "@/hooks/pos/usePaymentSession";
import type {
  PosTenderKind,
  PosSessionTenderInput,
} from "@/lib/pos/paymentSessionClient";


/**
 * Shape returned to the parent at commit. Mirrors the historical
 * external contract of this dialog — the internal source of truth is
 * `pos_payment_session_tenders` fetched via `usePaymentSession`.
 */
export interface PaymentDialogPayment {
  method: string;
  amount: number;
  tendered_amount?: number;
  change_given?: number;
  reference?: string;
  auth_state?: "approved" | "captured";
  auth_id?: string;
  vendor_txn_id?: string;
  authorized_amount?: number;
  card_last_four?: string;
  card_type?: string;
}


/**
 * Context required to open (or rehydrate) the payment session that
 * backs this dialog. Retail passes `useCommitKey.get(register, shift)`
 * as the idempotency key; restaurant passes `cart.transactionId` (the
 * draft id) so the commit RPC forwards to `finalize_table_order`.
 */
export interface PaymentSessionContext {
  registerId: string;
  shiftId: string;
  cashierId?: string | null;
  /**
   * Stable idempotency key for the session. The same value MUST be
   * reused on retries and mid-payment refreshes so the DB session
   * collapses to a single row.
   */
  idempotencyKey: string;
  /** Currency of the sale — passed through to `pos_payment_session_open`. */
  currency?: string;
}


interface PaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  total: number;
  posTransactionId?: string;
  tipAmount?: number;
  onTipChange?: (tip: number) => void;
  splitPortionLabel?: string;
  hasCustomer?: boolean;
  registerPaymentMethods?: string[] | null;
  /**
   * Required — identifies the payment session. Without this the dialog
   * cannot record tenders and would silently fall back to client-only
   * math (Wave 3 · Phase 4.c-follow).
   */
  sessionContext: PaymentSessionContext;
  onComplete: (payments: PaymentDialogPayment[]) => void;
}

const iconMap: Record<string, React.ElementType> = {
  Banknote,
  CreditCard,
  Smartphone,
  Building,
  FileText,
  Wallet,
};

/**
 * Map a `pos_payment_session_tenders` row (server-authoritative) back
 * to the `PaymentDialogPayment` shape the parent expects at commit.
 * We only propagate metadata the DB actually stores; card `card_last_four`
 * / `card_type` come from `driver_payload` (jsonb) when present.
 */
function tenderRowToDialogPayment(row: PaymentSessionTenderRow): PaymentDialogPayment {
  const payload = (row.driver_payload ?? {}) as Record<string, unknown>;
  const authState = row.auth_state as PaymentDialogPayment["auth_state"] | null | undefined;
  return {
    method: row.method_key ?? row.tender_kind,
    amount: Number(row.amount),
    tendered_amount: Number(row.tendered_amount ?? row.amount),
    change_given: Number(row.change_given ?? 0),
    reference: row.reference ?? undefined,
    auth_state: authState ?? undefined,
    auth_id: row.auth_id ?? undefined,
    vendor_txn_id: row.vendor_txn_id ?? undefined,
    authorized_amount:
      typeof payload.authorized_amount === "number"
        ? (payload.authorized_amount as number)
        : undefined,
    card_last_four:
      typeof payload.card_last_four === "string"
        ? (payload.card_last_four as string)
        : undefined,
    card_type:
      typeof payload.card_type === "string" ? (payload.card_type as string) : undefined,
  };
}

export function PaymentDialog({
  open,
  onOpenChange,
  total,
  posTransactionId,
  tipAmount = 0,
  onTipChange,
  splitPortionLabel,
  hasCustomer = false,
  registerPaymentMethods,
  sessionContext,
  onComplete,
}: PaymentDialogProps) {
  const { formatCurrency, getCurrencySymbol } = useCurrency();
  const [localTip, setLocalTip] = useState("");
  const effectiveTotal = total + tipAmount;
  const { enabledPaymentMethods: allEnabledMethods, isLoading, cashRoundingSettings } = usePOSSettings();
  const { configs: providerConfigs, getProviderConfig } = usePaymentProviders();

  // Resolver = single source of truth for what's actually usable here.
  // Combines is_enabled, register allow-list, provider readiness, clearing
  // GL account, and customer context. Non-ready methods are still listed so
  // the UI can render them as disabled chips with a clear blockedMessage.
  const resolved = resolvePaymentMethods({
    enabledMethods: allEnabledMethods,
    registerAllowList: registerPaymentMethods ?? null,
    providerConfigs: providerConfigs.map((c) => ({ provider: c.provider, is_active: c.is_active })),
    hasCustomer,
  });
  const readyMethods = resolved.filter((m) => m.isReady);
  const enabledPaymentMethods = allEnabledMethods.filter((m) =>
    readyMethods.some((r) => r.method_key === m.method_key),
  );

  // Server-authoritative payment session. This is the ONLY source of
  // truth for tenders and their totals inside the dialog — no local
  // useState<PaymentDialogPayment[]>, no `.reduce` over payments. The
  // architecture guard `no-client-payment-math` blocks that pattern.
  const session = usePaymentSession({
    registerId: sessionContext.registerId,
    shiftId: sessionContext.shiftId,
    cashierId: sessionContext.cashierId ?? null,
    idempotencyKey: sessionContext.idempotencyKey,
    totals: {
      grandTotal: effectiveTotal,
      currency: sessionContext.currency ?? "KES",
      tipAmount,
    },
    autoRehydrate: open,
  });

  // Derived, from server rows only.
  const tenderRows = useMemo(
    () => session.tenders.filter((t) => t.reversed_at == null),
    [session.tenders],
  );
  const payments = useMemo(
    () => tenderRows.map(tenderRowToDialogPayment),
    [tenderRows],
  );
  const totalApplied = session.allocated;
  const totalTendered = session.totalTendered;
  const totalChange = session.totalChange;
  const remaining = session.remaining;
  const change = session.change;

  const [selectedMethod, setSelectedMethod] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [cashTendered, setCashTendered] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [showMpesaModal, setShowMpesaModal] = useState(false);
  const [showSplitMpesaModal, setShowSplitMpesaModal] = useState(false);
  const [splitMpesaAmount, setSplitMpesaAmount] = useState<number>(0);
  const [showC2BLookup, setShowC2BLookup] = useState(false);
  const [showCardModal, setShowCardModal] = useState(false);
  const [cardModalAmount, setCardModalAmount] = useState<number>(0);
  const [cardModalMode, setCardModalMode] = useState<"full" | "split">("full");

  // Cash rounding helper
  const applyCashRounding = (amt: number): number => {
    if (!cashRoundingSettings.enabled || cashRoundingSettings.precision <= 0) return amt;
    return Math.round(amt / cashRoundingSettings.precision) * cashRoundingSettings.precision;
  };

  const roundedEffectiveTotal = applyCashRounding(effectiveTotal);
  const cashRoundingDiff = roundedEffectiveTotal - effectiveTotal;
  const mpesaConfig = getProviderConfig("mpesa");
  const isMpesaEnabled = mpesaConfig?.is_active;

  useEffect(() => {
    if (enabledPaymentMethods.length > 0 && !selectedMethod) {
      setSelectedMethod(enabledPaymentMethods[0].method_key);
    }
  }, [enabledPaymentMethods, selectedMethod]);

  // For quick cash payment
  const cashPaymentChange = parseFloat(cashTendered) - effectiveTotal;

  const selectedMethodConfig = enabledPaymentMethods.find((m) => m.method_key === selectedMethod);
  const cashMethod = enabledPaymentMethods.find((m) => m.tender_kind === "cash");
  const creditLiabilityMethod = enabledPaymentMethods.find((m) => m.tender_kind === "credit_liability");
  const mpesaWalletMethod = enabledPaymentMethods.find(
    (m) => m.tender_kind === "wallet" && m.provider_key === "mpesa",
  );
  const cardMethod = enabledPaymentMethods.find((m) => m.tender_kind === "card");
  const selectedTenderKind = selectedMethodConfig?.tender_kind;
  const selectedCaptureMode = selectedMethodConfig?.capture_mode;
  const selectedProviderKey = selectedMethodConfig?.provider_key;

  const canSplitPayment = enabledPaymentMethods.length >= 2;

  /**
   * Central helper: record a tender through the session RPC. All
   * add-tender paths (split add, quick cash, quick card, quick credit,
   * full/split mpesa, full/split card) MUST funnel through here so the
   * DB session — not a client array — owns state.
   */
  const recordTenderRow = useCallback(
    async (input: PosSessionTenderInput): Promise<PaymentSessionTenderRow | null> => {
      try {
        setIsRecording(true);
        const row = await session.recordTender(input);
        return row;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to record payment";
        toast.error(msg);
        return null;
      } finally {
        setIsRecording(false);
      }
    },
    [session],
  );

  /**
   * Reset transient input state. We do NOT clear session tenders here —
   * those live in the DB, and are cleared by either successful commit
   * (POSTerminal calls session.commit → completeTransaction) or the
   * abandoned-session sweeper.
   */
  const resetForm = useCallback(() => {
    setAmount("");
    setReference("");
    setCashTendered("");
    setShowMpesaModal(false);
    setShowSplitMpesaModal(false);
    setSplitMpesaAmount(0);
    setShowCardModal(false);
    setCardModalAmount(0);
    setCardModalMode("full");
    if (enabledPaymentMethods.length > 0) {
      setSelectedMethod(enabledPaymentMethods[0].method_key);
    }
  }, [enabledPaymentMethods]);

  /**
   * Finalize with the current server-authoritative tender list. The
   * parent commits through its own `useCommitKey`-scoped
   * `process_pos_transaction` (retail) or `finalize_table_order`
   * (restaurant) call. Both use the same idempotency key as the
   * session, so the RPC collapses duplicates on retry.
   */
  const finalizeWith = useCallback(
    (rows: PaymentSessionTenderRow[]) => {
      const active = rows.filter((t) => t.reversed_at == null);
      onComplete(active.map(tenderRowToDialogPayment));
      resetForm();
    },
    [onComplete, resetForm],
  );

  const handleAddPayment = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    const paymentAmount = parseFloat(amount);

    if (selectedTenderKind === "wallet" && selectedProviderKey === "mpesa" && isMpesaEnabled) {
      setSplitMpesaAmount(paymentAmount);
      setShowSplitMpesaModal(true);
      return;
    }

    if (selectedTenderKind === "card") {
      setCardModalAmount(paymentAmount);
      setCardModalMode("split");
      setShowCardModal(true);
      return;
    }

    if (selectedTenderKind === "credit_liability" && !hasCustomer) {
      toast.error("Please select a customer before using Store Credit");
      return;
    }

    if (selectedMethodConfig?.requires_reference && !reference.trim()) {
      toast.error(
        `A reference is required for ${selectedMethodConfig.display_name} so finance can reconcile this payment.`,
      );
      return;
    }

    if (!selectedMethodConfig) return;
    const row = await recordTenderRow({
      tender_kind: selectedMethodConfig.tender_kind as PosTenderKind,
      method_key: selectedMethodConfig.method_key,
      provider_key: selectedMethodConfig.provider_key ?? null,
      amount: paymentAmount,
      tendered_amount: paymentAmount,
      change_given: 0,
      reference: reference.trim() || null,
    });
    if (row) {
      setAmount("");
      setReference("");
    }
  };

  const handleRemovePayment = async (index: number) => {
    const row = tenderRows[index];
    if (!row) return;
    try {
      setIsRecording(true);
      await session.reverseTender(row.id, "cashier removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove payment");
    } finally {
      setIsRecording(false);
    }
  };

  const handleQuickCashPayment = async () => {
    if (!cashMethod) return;
    const applied = cashRoundingSettings.enabled ? roundedEffectiveTotal : effectiveTotal;
    const parsed = parseFloat(cashTendered);
    const tendered = Number.isFinite(parsed) && parsed >= applied ? parsed : applied;
    const changeGiven = Math.max(0, tendered - applied);
    const row = await recordTenderRow({
      tender_kind: "cash",
      method_key: cashMethod.method_key,
      amount: applied,
      tendered_amount: tendered,
      change_given: changeGiven,
    });
    if (!row) return;
    // Read the freshly-updated tender list off the session.
    finalizeWith([...tenderRows, row]);
  };

  const handleSplitPayment = () => {
    if (totalApplied < effectiveTotal) return;
    finalizeWith(tenderRows);
  };

  const handleTipQuick = (percent: number) => {
    const tip = Math.round(total * percent) / 100;
    setLocalTip(tip.toString());
    onTipChange?.(tip);
  };

  // Wave 2 · Phase C-2 — card handlers now funnel through the session.
  const cardAuthToTender = (
    auth: CardAuthPayload,
    amountApplied: number,
  ): PosSessionTenderInput => {
    if (!cardMethod) throw new Error("card tender missing from catalog");
    return {
      tender_kind: "card",
      method_key: cardMethod.method_key,
      provider_key: cardMethod.provider_key ?? null,
      amount: amountApplied,
      tendered_amount: amountApplied,
      change_given: 0,
      reference: auth.authId,
      auth_state: auth.initialAuthState,
      auth_id: auth.authId,
      vendor_txn_id: auth.vendorTxnId,
      driver_payload: {
        authorized_amount: auth.authorizedAmount,
        card_last_four: auth.cardLastFour,
        card_type: auth.cardType,
      },
    };
  };

  const handleCardSuccess = async (auth: CardAuthPayload) => {
    const wasFull = cardModalMode === "full";
    const row = await recordTenderRow(cardAuthToTender(auth, cardModalAmount));
    setShowCardModal(false);
    setCardModalAmount(0);
    if (!row) return;
    if (wasFull) {
      finalizeWith([...tenderRows, row]);
    } else {
      setAmount("");
    }
  };

  const handleMpesaSuccess = async (receiptNumber: string) => {
    if (!mpesaWalletMethod) return;
    const row = await recordTenderRow({
      tender_kind: "wallet",
      method_key: mpesaWalletMethod.method_key,
      provider_key: mpesaWalletMethod.provider_key ?? "mpesa",
      amount: effectiveTotal,
      tendered_amount: effectiveTotal,
      change_given: 0,
      reference: receiptNumber,
    });
    if (!row) return;
    finalizeWith([...tenderRows, row]);
  };

  const handleSplitMpesaSuccess = async (receiptNumber: string) => {
    if (!mpesaWalletMethod) return;
    const row = await recordTenderRow({
      tender_kind: "wallet",
      method_key: mpesaWalletMethod.method_key,
      provider_key: mpesaWalletMethod.provider_key ?? "mpesa",
      amount: splitMpesaAmount,
      tendered_amount: splitMpesaAmount,
      change_given: 0,
      reference: receiptNumber,
    });
    setShowSplitMpesaModal(false);
    setSplitMpesaAmount(0);
    if (!row) return;
    setAmount("");
  };

  const handleMpesaClick = () => setShowMpesaModal(true);

  const handleClose = (open: boolean) => {
    if (!open) resetForm();
    onOpenChange(open);
  };

  const getQuickAmounts = () => {
    const amounts: number[] = [];
    amounts.push(effectiveTotal);
    const roundUps = [10, 20, 50, 100];
    for (const round of roundUps) {
      const rounded = Math.ceil(effectiveTotal / round) * round;
      if (rounded > effectiveTotal && !amounts.includes(rounded)) {
        amounts.push(rounded);
      }
    }
    return amounts.slice(0, 4).sort((a, b) => a - b);
  };

  const quickAmounts = getQuickAmounts();

  const isCashEnabled = Boolean(cashMethod);
  const isCreditEnabled = Boolean(creditLiabilityMethod);
  const isCardEnabled = Boolean(cardMethod);

  const handleCardQuickPay = () => {
    if (!cardMethod) return;
    const amt = payments.length === 0 ? effectiveTotal : remaining;
    if (amt <= 0) return;
    setCardModalAmount(amt);
    setCardModalMode(payments.length === 0 ? "full" : "split");
    setShowCardModal(true);
  };

  const handleCreditQuickPay = async () => {
    if (!creditLiabilityMethod) return;
    if (!hasCustomer) {
      toast.error("Please select a customer before using Store Credit");
      return;
    }
    const creditAmount = payments.length === 0 ? effectiveTotal : remaining;
    if (creditAmount <= 0) return;
    const wasFull = payments.length === 0;
    const row = await recordTenderRow({
      tender_kind: "credit_liability",
      method_key: creditLiabilityMethod.method_key,
      amount: creditAmount,
      tendered_amount: creditAmount,
      change_given: 0,
    });
    if (!row) return;
    if (wasFull) {
      finalizeWith([...tenderRows, row]);
    }
  };



  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="w-[95vw] max-w-lg max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="text-lg sm:text-xl">Payment</DialogTitle>
        </DialogHeader>
        
        {isLoading ? (
          <div className="flex items-center justify-center py-8 sm:py-12">
            <Loader2 className="h-6 w-6 sm:h-8 sm:w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
        <div className="space-y-3 sm:space-y-4">
            {/* M-Pesa: STK Push (push) + C2B lookup (pull) */}
            {isMpesaEnabled && remaining > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="w-full h-12 sm:h-14 border-2 border-[#4caf50] hover:bg-[#4caf50]/10 justify-start gap-2 sm:gap-3"
                  onClick={() => {
                    if (payments.length === 0) {
                      handleMpesaClick();
                    } else {
                      setSplitMpesaAmount(remaining);
                      setShowSplitMpesaModal(true);
                    }
                  }}
                >
                  <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-[#4caf50] flex items-center justify-center flex-shrink-0">
                    <Smartphone className="h-4 w-4 sm:h-5 sm:w-5 text-white" />
                  </div>
                  <div className="text-left min-w-0">
                    <p className="font-medium text-sm sm:text-base">
                      {payments.length === 0 ? "Send STK Push" : `STK ${formatCurrency(remaining)}`}
                    </p>
                    <p className="text-[10px] sm:text-xs text-muted-foreground truncate">Prompt customer's phone</p>
                  </div>
                </Button>
                <Button
                  variant="outline"
                  className="w-full h-12 sm:h-14 border-2 border-[#4caf50]/60 hover:bg-[#4caf50]/10 justify-start gap-2 sm:gap-3"
                  onClick={() => setShowC2BLookup(true)}
                  disabled={!posTransactionId}
                  title={!posTransactionId ? "Save the sale first to enable lookup" : undefined}
                >
                  <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-[#4caf50]/80 flex items-center justify-center flex-shrink-0">
                    <Search className="h-4 w-4 sm:h-5 sm:w-5 text-white" />
                  </div>
                  <div className="text-left min-w-0">
                    <p className="font-medium text-sm sm:text-base">Look up M-Pesa</p>
                    <p className="text-[10px] sm:text-xs text-muted-foreground truncate">
                      Customer already paid via paybill/till
                    </p>
                  </div>
                </Button>
              </div>
            )}

            {/* Store Credit / Customer Account Quick Pay Button */}
            {isCreditEnabled && remaining > 0 && (
              <Button
                variant="outline"
                className="w-full h-12 sm:h-14 border-2 border-primary hover:bg-primary/10 justify-start gap-2 sm:gap-3"
                onClick={handleCreditQuickPay}
              >
                <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-primary flex items-center justify-center flex-shrink-0">
                  <Wallet className="h-4 w-4 sm:h-5 sm:w-5 text-primary-foreground" />
                </div>
                <div className="text-left min-w-0">
                  <p className="font-medium text-sm sm:text-base">
                    {payments.length === 0 ? "Charge to Customer Account" : `Charge ${formatCurrency(remaining)} to Account`}
                  </p>
                  <p className="text-[10px] sm:text-xs text-muted-foreground truncate">Buy now, pay later — generates invoice</p>
                </div>
              </Button>
            )}

            {/* Card Terminal Quick Pay (Wave 2 · Phase C-2) */}
            {isCardEnabled && remaining > 0 && (
              <Button
                variant="outline"
                className="w-full h-12 sm:h-14 border-2 border-blue-500 hover:bg-blue-500/10 justify-start gap-2 sm:gap-3"
                onClick={handleCardQuickPay}
              >
                <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-blue-500 flex items-center justify-center flex-shrink-0">
                  <CreditCard className="h-4 w-4 sm:h-5 sm:w-5 text-white" />
                </div>
                <div className="text-left min-w-0">
                  <p className="font-medium text-sm sm:text-base">
                    {payments.length === 0
                      ? `Card · ${formatCurrency(effectiveTotal)}`
                      : `Card · ${formatCurrency(remaining)}`}
                  </p>
                  <p className="text-[10px] sm:text-xs text-muted-foreground truncate">
                    {cardMethod?.capture_mode === "two_step"
                      ? "Authorize now, capture on settlement"
                      : "Authorize + capture immediately"}
                  </p>
                </div>
              </Button>
            )}


            {/* Total Display */}
            <div className="text-center py-3 sm:py-4 bg-muted/50 rounded-lg">
              {splitPortionLabel && (
                <p className="text-xs font-medium text-primary mb-1">{splitPortionLabel}</p>
              )}
              <p className="text-xs sm:text-sm text-muted-foreground mb-1">Amount Due</p>
              <p className="text-2xl sm:text-4xl font-bold">{formatCurrency(effectiveTotal)}</p>
              {tipAmount > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Subtotal: {formatCurrency(total)} + Tip: {formatCurrency(tipAmount)}
                </p>
              )}
              {cashRoundingSettings.enabled && cashRoundingDiff !== 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Cash rounding: {cashRoundingDiff > 0 ? "+" : ""}{formatCurrency(cashRoundingDiff)} → {formatCurrency(roundedEffectiveTotal)}
                </p>
              )}
            </div>

            {/* Tip Section */}
            {onTipChange && (
              <div className="space-y-2">
                <Label className="text-sm">Add Tip</Label>
                <div className="flex gap-1.5">
                  {[10, 15, 20].map(pct => (
                    <Button
                      key={pct}
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs"
                      onClick={() => handleTipQuick(pct)}
                    >
                      {pct}%
                    </Button>
                  ))}
                  <div className="flex-1">
                    <Input
                      type="number"
                      step="0.01"
                      value={localTip}
                      onChange={(e) => {
                        setLocalTip(e.target.value);
                        onTipChange(parseFloat(e.target.value) || 0);
                      }}
                      placeholder="Custom"
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Quick Cash Payment - Only show if cash is enabled and no payments added yet */}
            {isCashEnabled && payments.length === 0 && (
              <>
                <div className="space-y-2 sm:space-y-3">
                  <Label className="text-sm">Quick Cash Payment</Label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2">
                    {quickAmounts.map((amt) => (
                        <Button
                          key={amt}
                          variant="outline"
                          size="sm"
                          onClick={() => setCashTendered(amt.toString())}
                          className={cn(
                            "text-xs sm:text-sm",
                            cashTendered === amt.toString() && "border-primary"
                          )}
                        >
                          {formatCurrency(amt)}
                        </Button>
                    ))}
                  </div>
                  
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      step="0.01"
                      value={cashTendered}
                      onChange={(e) => setCashTendered(e.target.value)}
                      placeholder="Cash tendered"
                      className="text-base sm:text-lg"
                    />
                    <Button 
                      onClick={handleQuickCashPayment}
                      disabled={!cashTendered || parseFloat(cashTendered) < effectiveTotal}
                      className="whitespace-nowrap text-sm px-3"
                    >
                      <Banknote className="h-4 w-4 mr-1 sm:mr-2" />
                      <span className="hidden xs:inline">Pay</span> Cash
                    </Button>
                  </div>
                  
                  {cashTendered && parseFloat(cashTendered) >= effectiveTotal && (
                    <div className="bg-green-500/10 text-green-600 rounded-lg p-2 sm:p-3 flex items-center gap-2">
                      <CheckCircle className="h-4 w-4 sm:h-5 sm:w-5 flex-shrink-0" />
                      <span className="font-medium text-sm sm:text-base">Change: {formatCurrency(cashPaymentChange)}</span>
                    </div>
                  )}
                </div>

                {canSplitPayment ? (
                  <div className="relative">
                    <Separator />
                    <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs sm:text-sm text-muted-foreground">
                      or split payment
                    </span>
                  </div>
                ) : null}
              </>
            )}

            {/* Split Payment */}
            <div className="space-y-2 sm:space-y-3">
              {payments.length > 0 && (
                <div className="space-y-2">
                  {payments.map((payment, index) => {
                    const method = enabledPaymentMethods.find((m) => m.method_key === payment.method);
                    const IconComponent = method?.icon ? iconMap[method.icon] : CreditCard;
                    return (
                      <div key={index} className="flex items-center justify-between p-2 border rounded-lg gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {IconComponent && <IconComponent className="h-4 w-4 flex-shrink-0" />}
                          <span className="text-sm truncate">{method?.display_name || payment.method}</span>
                          {payment.reference && (
                            <Badge variant="outline" className="text-[10px] hidden sm:inline-flex">
                              {payment.reference}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
                          <span className="font-medium text-sm">{formatCurrency(payment.amount)}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 sm:h-8 sm:w-8 text-destructive"
                            onClick={() => handleRemovePayment(index)}
                          >
                            <Trash2 className="h-3 w-3 sm:h-4 sm:w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}

                  {remaining > 0 && (
                    <div className="text-xs sm:text-sm text-muted-foreground">
                      Remaining: <span className="font-medium">{formatCurrency(remaining)}</span>
                    </div>
                  )}

                  {change > 0 && (
                    <div className="bg-green-500/10 text-green-600 rounded-lg p-2 sm:p-3 text-sm">
                      Change due: <span className="font-medium">{formatCurrency(change)}</span>
                    </div>
                  )}
                </div>
              )}

              {remaining > 0 && canSplitPayment && (
                <div className="space-y-2 sm:space-y-3">
                  <div className="flex flex-wrap gap-1.5 sm:gap-2">
                    <TooltipProvider delayDuration={150}>
                      {resolved.map((r) => {
                        const source = allEnabledMethods.find((m) => m.method_key === r.method_key);
                        const IconComponent = r.icon ? iconMap[r.icon] : CreditCard;
                        const isReady = r.isReady;
                        const btn = (
                          <Button
                            key={r.method_key}
                            type="button"
                            variant={selectedMethod === r.method_key ? "default" : "outline"}
                            size="sm"
                            className={cn(
                              "text-xs sm:text-sm px-2 sm:px-3",
                              !isReady && "opacity-50 cursor-not-allowed",
                            )}
                            disabled={!isReady}
                            aria-disabled={!isReady}
                            onClick={() => isReady && setSelectedMethod(r.method_key)}
                          >
                            {IconComponent && <IconComponent className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />}
                            <span className="hidden xs:inline">{r.display_name}</span>
                            <span className="xs:hidden">{r.display_name.slice(0, 4)}</span>
                          </Button>
                        );
                        if (isReady || !source) return btn;
                        const settingsHref =
                          r.blockedReason === "customer_required"
                            ? "#"
                            : r.blockedReason === "missing_debit_account"
                            ? "/pos/settings#payment-methods"
                            : "/pos/settings#providers";
                        return (
                          <Tooltip key={r.method_key}>
                            <TooltipTrigger asChild>
                              <span tabIndex={0}>{btn}</span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[240px] text-xs">
                              <div>{r.blockedMessage}</div>
                              {settingsHref !== "#" && (
                                <RouterLink
                                  to={settingsHref}
                                  className="mt-1 inline-block underline text-primary"
                                >
                                  Configure
                                </RouterLink>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </TooltipProvider>
                  </div>

                  <div className="flex gap-2">
                    <Input
                      type="number"
                      step="0.01"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={`Amount (${formatCurrency(remaining)})`}
                      className="text-sm"
                    />
                    {selectedMethodConfig?.requires_reference && (
                      <Input
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                        placeholder="Ref"
                        className="w-20 sm:w-32 text-sm"
                      />
                    )}
                    <Button onClick={handleAddPayment} disabled={!amount} size="sm">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
              {remaining > 0 && !canSplitPayment && payments.length === 0 && enabledPaymentMethods.length === 1 && (
                <p className="text-xs text-muted-foreground italic">
                  Only {enabledPaymentMethods[0].display_name} is enabled on this register.
                  Enable another payment method in Settings to split payments.
                </p>
              )}
            </div>

            {/* Complete Button */}
            {payments.length > 0 && totalApplied >= effectiveTotal && (
              <Button className="w-full h-10 sm:h-12 text-sm sm:text-lg" onClick={handleSplitPayment}>
                <CheckCircle className="h-4 w-4 sm:h-5 sm:w-5 mr-2" />
                Complete Payment
              </Button>
            )}
          </div>
        )}

        {/* M-Pesa Payment Modal - Full Payment */}
        <MpesaPaymentModal
          open={showMpesaModal}
          onOpenChange={setShowMpesaModal}
          amount={effectiveTotal}
          posTransactionId={posTransactionId}
          onSuccess={handleMpesaSuccess}
          onCancel={() => setShowMpesaModal(false)}
        />

        {/* M-Pesa Payment Modal - Split Payment */}
        <MpesaPaymentModal
          open={showSplitMpesaModal}
          onOpenChange={setShowSplitMpesaModal}
          amount={splitMpesaAmount}
          posTransactionId={posTransactionId}
          onSuccess={handleSplitMpesaSuccess}
          onCancel={() => {
            setShowSplitMpesaModal(false);
            setSplitMpesaAmount(0);
          }}
        />

        {/* M-Pesa C2B Lookup (cashier pulls existing paybill payment) */}
        <MpesaC2BLookupModal
          open={showC2BLookup}
          onOpenChange={setShowC2BLookup}
          posTransactionId={posTransactionId ?? null}
          remaining={remaining > 0 ? remaining : effectiveTotal}
          onAttached={({ transId, amount }) => {
            // Mirror the payment line locally so the dialog reflects the
            // attach. The RPC has already inserted the row in the DB.
            const newPayments: PaymentDialogPayment[] = [
              ...payments,
              {
                method: mpesaWalletMethod?.method_key ?? "mobile_money",

                amount,
                tendered_amount: amount,
                change_given: 0,
                reference: transId,
              },
            ];
            setPayments(newPayments);
            const newTotal = newPayments.reduce((s, p) => s + p.amount, 0);
            if (newTotal >= effectiveTotal) {
              onComplete(newPayments);
              resetForm();
            }
          }}
        />

        {/* Card Terminal Modal (Wave 2 · Phase C-2) */}
        <CardPaymentModal
          open={showCardModal}
          onOpenChange={setShowCardModal}
          amount={cardModalAmount}
          captureMode={
            (cardMethod?.capture_mode as "auth_only" | "auth_capture") ?? "auth_capture"
          }
          onSuccess={handleCardSuccess}
          onCancel={() => {
            setShowCardModal(false);
            setCardModalAmount(0);
          }}
        />
      </DialogContent>

    </Dialog>
  );
}
