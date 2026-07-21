/**
 * TenderWorkspace — Phase-3b, route-owned surface for
 * `terminalState.phase === "tender"`.
 *
 * Replaces the legacy `PaymentDialog` (previously mounted as a full-screen
 * `<Dialog>` inside `POSTerminal`) with a real workstation workspace: a
 * `<section>` that fills the terminal region provided by `TerminalShell`,
 * with no Dialog chrome. All payment-session semantics, split-tender
 * handling, quick-cash keypad affordances, M-Pesa STK/C2B, card auth and
 * finalize behaviour are preserved 1:1 from the previous implementation —
 * only the presentation shell (Dialog → section) and the exit mechanism
 * (onOpenChange → onBack dispatching `backToSale`) changed.
 *
 * Escape key and the header "Back" button both trigger `onBack` so the
 * reducer graduates the terminal back to `sale` without any composite
 * state living on the workspace.
 *
 * See `docs/architecture/POS_WORKSTATION_STATES.md`.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  ArrowLeft,
  Search,
} from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { usePaymentProviders } from "@/hooks/usePaymentProviders";
import { resolvePaymentMethods } from "@/lib/pos/paymentMethodResolver";
import { cn } from "@/lib/utils";
import { MpesaPaymentModal } from "@/components/pos/MpesaPaymentModal";
import { MpesaC2BLookupModal } from "@/components/pos/MpesaC2BLookupModal";
import { CardPaymentModal, type CardAuthPayload } from "@/components/pos/CardPaymentModal";
import { toast } from "sonner";
import {
  usePaymentSession,
  type PaymentSessionTenderRow,
} from "@/hooks/pos/usePaymentSession";
import {
  POSPaymentSessionError,
  type PosTenderKind,
  type PosSessionTenderInput,
} from "@/lib/pos/paymentSessionClient";
import { useCart } from "@/apps/pos/terminal/sale/CartContext";
import { TransactionSummaryRail } from "@/apps/pos/terminal/sale/components/TransactionSummaryRail";


function paymentSessionErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof POSPaymentSessionError) {
    const parts = [e.message];
    if (e.code) parts.push(`[${e.code}]`);
    // eslint-disable-next-line no-console
    console.error("[pos-payment-session]", {
      rpc: e.rpc,
      code: e.code,
      hint: e.hint,
      details: e.details,
      message: e.message,
    });
    if (e.hint) parts.push(`— ${e.hint}`);
    return parts.join(" ");
  }
  return e instanceof Error ? e.message : fallback;
}

export interface TenderWorkspacePayment {
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

export interface TenderSessionContext {
  registerId: string;
  shiftId: string;
  cashierId?: string | null;
  idempotencyKey: string;
  currency?: string;
}

interface TenderWorkspaceProps {
  total: number;
  posTransactionId?: string;
  tipAmount?: number;
  onTipChange?: (tip: number) => void;
  splitPortionLabel?: string;
  hasCustomer?: boolean;
  registerPaymentMethods?: string[] | null;
  sessionContext: TenderSessionContext;
  onComplete: (payments: TenderWorkspacePayment[]) => void;
  onBack: () => void;
}

const iconMap: Record<string, React.ElementType> = {
  Banknote,
  CreditCard,
  Smartphone,
  Building,
  FileText,
  Wallet,
};

function tenderRowToPayment(row: PaymentSessionTenderRow): TenderWorkspacePayment {
  const payload = (row.driver_payload ?? {}) as Record<string, unknown>;
  const authState = row.auth_state as TenderWorkspacePayment["auth_state"] | null | undefined;
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

export function TenderWorkspace({
  total,
  posTransactionId,
  tipAmount = 0,
  onTipChange,
  splitPortionLabel,
  hasCustomer = false,
  registerPaymentMethods,
  sessionContext,
  onComplete,
  onBack,
}: TenderWorkspaceProps) {
  const { formatCurrency } = useCurrency();
  const [localTip, setLocalTip] = useState("");
  const effectiveTotal = total + tipAmount;
  const { enabledPaymentMethods: allEnabledMethods, isLoading, cashRoundingSettings } = usePOSSettings();
  const { configs: providerConfigs, getProviderConfig } = usePaymentProviders();

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
    autoRehydrate: true,
  });

  const tenderRows = useMemo(
    () => session.tenders.filter((t) => t.reversed_at == null),
    [session.tenders],
  );
  const payments = useMemo(() => tenderRows.map(tenderRowToPayment), [tenderRows]);
  const totalApplied = session.allocated;
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const cashPaymentChange = parseFloat(cashTendered) - effectiveTotal;
  const selectedMethodConfig = enabledPaymentMethods.find((m) => m.method_key === selectedMethod);
  const cashMethod = enabledPaymentMethods.find((m) => m.tender_kind === "cash");
  const creditLiabilityMethod = enabledPaymentMethods.find((m) => m.tender_kind === "credit_liability");
  const mpesaWalletMethod = enabledPaymentMethods.find(
    (m) => m.tender_kind === "wallet" && m.provider_key === "mpesa",
  );
  const cardMethod = enabledPaymentMethods.find((m) => m.tender_kind === "card");
  const selectedTenderKind = selectedMethodConfig?.tender_kind;
  const selectedProviderKey = selectedMethodConfig?.provider_key;
  const canSplitPayment = enabledPaymentMethods.length >= 2;

  const recordTenderRow = useCallback(
    async (input: PosSessionTenderInput): Promise<PaymentSessionTenderRow | null> => {
      try {
        setIsRecording(true);
        const row = await session.recordTender(input);
        return row;
      } catch (e) {
        toast.error(paymentSessionErrorMessage(e, "Failed to record payment"));
        return null;
      } finally {
        setIsRecording(false);
      }
    },
    [session],
  );

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

  const finalizeWith = useCallback(
    (rows: PaymentSessionTenderRow[]) => {
      const active = rows.filter((t) => t.reversed_at == null);
      onComplete(active.map(tenderRowToPayment));
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
      toast.error(paymentSessionErrorMessage(e, "Failed to remove payment"));
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

  const cardAuthToTender = (auth: CardAuthPayload, amountApplied: number): PosSessionTenderInput => {
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
    if (wasFull) finalizeWith([...tenderRows, row]);
    else setAmount("");
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
    if (wasFull) finalizeWith([...tenderRows, row]);
  };

  // Persistent transaction context — the Enerpize-style rail on the right
  // keeps cart totals visible during payment so the cashier never loses
  // sight of the sale they're closing. `useCart()` is safe here because
  // `TerminalShell` mounts `CartProvider` above every tender render.
  const railCart = useCart();
  const paidAmount = totalApplied;
  const canConfirm = payments.length > 0 && totalApplied >= effectiveTotal;


  return (
    <section
      aria-labelledby="tender-workspace-title"
      className="absolute inset-0 z-40 flex flex-col bg-background"
    >
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to sale">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 id="tender-workspace-title" className="text-lg font-semibold sm:text-xl">
            Payment
            {splitPortionLabel && (
              <span className="ml-2 text-sm font-normal text-primary">{splitPortionLabel}</span>
            )}
          </h1>
        </div>
        <div className="text-right">

          <p className="text-xs text-muted-foreground">Amount Due</p>
          <p className="text-xl font-bold sm:text-2xl">{formatCurrency(effectiveTotal)}</p>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
      <ScrollArea className="flex-1 min-w-0">

        <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6 sm:py-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 sm:py-12">
              <Loader2 className="h-6 w-6 sm:h-8 sm:w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-3 sm:space-y-4">
              {isMpesaEnabled && remaining > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    className="w-full h-12 sm:h-14 border-2 border-[#4caf50] hover:bg-[#4caf50]/10 justify-start gap-2 sm:gap-3"
                    onClick={() => {
                      if (payments.length === 0) handleMpesaClick();
                      else {
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

              {/* Amount Due block removed — the persistent TransactionSummaryRail
                  on the right already surfaces this and Enerpize-style layout
                  keeps the left column focused on payment method entry. */}
              {cashRoundingSettings.enabled && cashRoundingDiff !== 0 && (
                <div className="text-center py-2 bg-muted/40 rounded-md">
                  <p className="text-xs text-muted-foreground">
                    Cash rounding: {cashRoundingDiff > 0 ? "+" : ""}
                    {formatCurrency(cashRoundingDiff)} → {formatCurrency(roundedEffectiveTotal)}
                  </p>
                </div>
              )}


              {onTipChange && (
                <div className="space-y-2">
                  <Label className="text-sm">Add Tip</Label>
                  <div className="flex gap-1.5">
                    {[10, 15, 20].map((pct) => (
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
                            cashTendered === amt.toString() && "border-primary",
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
                        <span className="font-medium text-sm sm:text-base">
                          Change: {formatCurrency(cashPaymentChange)}
                        </span>
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
                              disabled={isRecording}
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
                                  <RouterLink to={settingsHref} className="mt-1 inline-block underline text-primary">
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
                    Only {enabledPaymentMethods[0].display_name} is enabled on this register. Enable another payment method in Settings to split payments.
                  </p>
                )}
              </div>

              {/* Confirm button lives in the persistent right rail below. */}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Persistent transaction summary rail — Enerpize-style.
          Keeps subtotal / discounts / tax / net-payable and paid / change
          visible for the entire tender phase. The Confirm CTA finalizes
          the split-payment flow when the tender is fully covered. */}
      <aside className="hidden md:flex w-80 xl:w-96 flex-col border-l bg-card">
        <div className="border-b px-4 py-3">
          <p className="text-xs text-muted-foreground">POS Client</p>
          <p className="text-sm font-semibold truncate">
            {railCart.customer?.name ?? "Walk-in customer"}
          </p>
        </div>
        <ScrollArea className="flex-1 min-h-0 px-4 py-3">
          <TransactionSummaryRail
            cart={railCart}
            appliedPromotions={[]}
            formatCurrency={formatCurrency}
            size="md"
          />
          <div className="mt-4 space-y-1.5 text-sm">
            {tipAmount > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Tip</span>
                <span>{formatCurrency(tipAmount)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold">
              <span>Net Payable</span>
              <span>{formatCurrency(effectiveTotal)}</span>
            </div>
            <Separator className="my-2" />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Paid</span>
              <span className="font-medium">{formatCurrency(paidAmount)}</span>
            </div>
            {remaining > 0 ? (
              <div className="flex justify-between text-amber-600">
                <span>Remaining</span>
                <span className="font-medium">{formatCurrency(remaining)}</span>
              </div>
            ) : (
              <div className="flex justify-between text-green-600">
                <span>Change</span>
                <span className="font-medium">{formatCurrency(change)}</span>
              </div>
            )}
          </div>
        </ScrollArea>
        <div className="border-t p-4">
          <Button
            className="w-full h-14 text-base bg-green-600 hover:bg-green-700 text-white"
            onClick={handleSplitPayment}
            disabled={!canConfirm || isRecording}
            aria-label="Confirm payment"
          >
            <CheckCircle className="h-5 w-5 mr-2" />
            Confirm
          </Button>
          {!canConfirm && (
            <p className="text-[11px] text-muted-foreground mt-2 text-center">
              {payments.length === 0
                ? "Add a payment to enable Confirm"
                : `Collect ${formatCurrency(remaining)} more to confirm`}
            </p>
          )}
        </div>
      </aside>
      </div>


      {/* Payment provider sub-modals — these remain modal because they wrap
          a device-driver conversation (STK push wait, card terminal auth).
          They are not workstation phases. */}
      <MpesaPaymentModal
        open={showMpesaModal}
        onOpenChange={setShowMpesaModal}
        amount={effectiveTotal}
        posTransactionId={posTransactionId}
        onSuccess={handleMpesaSuccess}
        onCancel={() => setShowMpesaModal(false)}
      />
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
      <MpesaC2BLookupModal
        open={showC2BLookup}
        onOpenChange={setShowC2BLookup}
        posTransactionId={posTransactionId ?? null}
        remaining={remaining > 0 ? remaining : effectiveTotal}
        onAttached={async ({ transId, amount: attachedAmount }) => {
          const row = await recordTenderRow({
            tender_kind: "wallet",
            method_key: mpesaWalletMethod?.method_key ?? "mobile_money",
            provider_key: "mpesa",
            amount: attachedAmount,
            tendered_amount: attachedAmount,
            change_given: 0,
            reference: transId,
          });
          if (!row) return;
          const nextRows = [...tenderRows, row];
          const nextTotal = nextRows.reduce((s, r) => s + Number(r.amount), 0);
          if (nextTotal >= effectiveTotal) finalizeWith(nextRows);
        }}
      />
      <CardPaymentModal
        open={showCardModal}
        onOpenChange={setShowCardModal}
        amount={cardModalAmount}
        captureMode={(cardMethod?.capture_mode as "auth_only" | "auth_capture") ?? "auth_capture"}
        onSuccess={handleCardSuccess}
        onCancel={() => {
          setShowCardModal(false);
          setCardModalAmount(0);
        }}
      />
    </section>
  );
}
