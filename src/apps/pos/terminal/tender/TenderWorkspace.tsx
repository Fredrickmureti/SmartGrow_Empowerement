/**
 * TenderWorkspace — Phase-3b, route-owned surface for
 * `terminalState.phase === "tender"`.
 *
 * Event-driven redesign (see .lovable/plan.md):
 *
 *   selectMethod(method)   → sets draft.methodKey (+ pre-fills amount = remaining)
 *   amendDraftAmount(n)    → keypad / quick-chips mutate draft.amount ONLY
 *   commitDraft()          → session.recordTender(draft) → tender row persisted
 *   reverseTender(id)      → session.reverseTender
 *   confirmPayment()       → auto-commits pending cash draft if it covers
 *                             remaining, then require remaining<=0 → onComplete
 *   back()                 → onBack()
 *
 * The workspace is a projection of `{ draft, session }`. Right rail is
 * authoritative for Paid / Remaining / Change — keypad never writes there.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
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
import { POSKeypad } from "@/components/pos/POSKeypad";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetHeader } from "@/components/ui/sheet";
import { Receipt } from "lucide-react";
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
import {
  TransactionSummaryRail,
  type AppliedPromotionLine,
} from "@/apps/pos/terminal/sale/components/TransactionSummaryRail";

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
  appliedPromotions?: AppliedPromotionLine[];
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

interface TenderDraft {
  methodKey: string;
  amount: string;
  reference: string;
}

export function TenderWorkspace({
  total,
  posTransactionId,
  tipAmount = 0,
  onTipChange,
  splitPortionLabel,
  hasCustomer = false,
  registerPaymentMethods,
  appliedPromotions = [],
  sessionContext,
  onComplete,
  onBack,
}: TenderWorkspaceProps) {
  const { formatCurrency } = useCurrency();
  const [localTip, setLocalTip] = useState("");
  const effectiveTotal = total + tipAmount;
  const {
    enabledPaymentMethods: allEnabledMethods,
    isLoading,
    cashRoundingSettings,
  } = usePOSSettings();
  const { configs: providerConfigs, getProviderConfig } = usePaymentProviders();

  const resolved = resolvePaymentMethods({
    enabledMethods: allEnabledMethods,
    registerAllowList: registerPaymentMethods ?? null,
    providerConfigs: providerConfigs.map((c) => ({
      provider: c.provider,
      is_active: c.is_active,
    })),
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

  // Single active tender draft — the only thing the keypad / chips mutate.
  const [draft, setDraft] = useState<TenderDraft>({
    methodKey: "",
    amount: "",
    reference: "",
  });
  const [isRecording, setIsRecording] = useState(false);
  const [showMpesaModal, setShowMpesaModal] = useState(false);
  const [pendingMpesaAmount, setPendingMpesaAmount] = useState<number>(0);
  const [showC2BLookup, setShowC2BLookup] = useState(false);
  const [showCardModal, setShowCardModal] = useState(false);
  const [pendingCardAmount, setPendingCardAmount] = useState<number>(0);

  const applyCashRounding = (amt: number): number => {
    if (!cashRoundingSettings.enabled || cashRoundingSettings.precision <= 0) return amt;
    return Math.round(amt / cashRoundingSettings.precision) * cashRoundingSettings.precision;
  };
  const roundedEffectiveTotal = applyCashRounding(effectiveTotal);
  const cashRoundingDiff = roundedEffectiveTotal - effectiveTotal;
  const mpesaConfig = getProviderConfig("mpesa");
  const isMpesaEnabled = Boolean(mpesaConfig?.is_active);

  const selectedMethodConfig = enabledPaymentMethods.find(
    (m) => m.method_key === draft.methodKey,
  );
  const selectedTenderKind = selectedMethodConfig?.tender_kind;
  const selectedProviderKey = selectedMethodConfig?.provider_key;
  const cashMethod = enabledPaymentMethods.find((m) => m.tender_kind === "cash");
  const mpesaWalletMethod = enabledPaymentMethods.find(
    (m) => m.tender_kind === "wallet" && m.provider_key === "mpesa",
  );
  const cardMethod = enabledPaymentMethods.find((m) => m.tender_kind === "card");

  // Default the draft method once enabled methods resolve. Prefer cash if present.
  useEffect(() => {
    if (draft.methodKey || enabledPaymentMethods.length === 0) return;
    const preferred = cashMethod ?? enabledPaymentMethods[0];
    setDraft((d) => ({ ...d, methodKey: preferred.method_key }));
  }, [enabledPaymentMethods, cashMethod, draft.methodKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const draftAmountNum = parseFloat(draft.amount) || 0;
  // For cash drafts we treat draft.amount as tendered; change previewed on rail.
  const draftIsCash = selectedTenderKind === "cash";
  const targetForDraft = remaining > 0 ? remaining : effectiveTotal;
  const draftCoversRemaining =
    draftIsCash && remaining > 0 && draftAmountNum >= remaining;

  const setDraftAmount = useCallback((v: string) => {
    setDraft((d) => ({ ...d, amount: v }));
  }, []);
  const selectMethod = useCallback(
    (methodKey: string) => {
      setDraft((d) => {
        if (d.methodKey === methodKey) return d;
        // Pre-fill the remaining amount so single-tender flow is one click.
        const nextAmount =
          remaining > 0 ? remaining.toFixed(2) : "";
        return { methodKey, amount: nextAmount, reference: "" };
      });
    },
    [remaining],
  );

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

  const resetDraftAfterCommit = useCallback(() => {
    setDraft((d) => ({ ...d, amount: "", reference: "" }));
  }, []);

  const finalizeWith = useCallback(
    (rows: PaymentSessionTenderRow[]) => {
      const active = rows.filter((t) => t.reversed_at == null);
      onComplete(active.map(tenderRowToPayment));
    },
    [onComplete],
  );

  // Commit the current draft as one tender row. Handles cash / wallet-mpesa /
  // card / other by routing to the correct driver modal or straight to RPC.
  const commitDraft = useCallback(
    async (opts: { closeIfCovers?: boolean } = {}): Promise<PaymentSessionTenderRow | null> => {
      if (!selectedMethodConfig) return null;
      if (draftAmountNum <= 0) return null;

      // Cash: draft.amount is what the customer handed over (tendered).
      if (selectedTenderKind === "cash") {
        const applied = cashRoundingSettings.enabled ? roundedEffectiveTotal : effectiveTotal;
        const owed = Math.min(applied - totalApplied, draftAmountNum);
        const chargedAmount = Math.max(0, owed);
        const changeGiven = Math.max(0, draftAmountNum - chargedAmount);
        const row = await recordTenderRow({
          tender_kind: "cash",
          method_key: selectedMethodConfig.method_key,
          amount: chargedAmount,
          tendered_amount: draftAmountNum,
          change_given: changeGiven,
        });
        if (row) {
          resetDraftAfterCommit();
          const nextRows = [...tenderRows, row];
          const nextTotal = nextRows.reduce((s, r) => s + Number(r.amount), 0);
          if (opts.closeIfCovers && nextTotal >= applied) finalizeWith(nextRows);
        }
        return row;
      }

      if (selectedTenderKind === "wallet" && selectedProviderKey === "mpesa" && isMpesaEnabled) {
        setPendingMpesaAmount(draftAmountNum);
        setShowMpesaModal(true);
        return null;
      }
      if (selectedTenderKind === "card") {
        setPendingCardAmount(draftAmountNum);
        setShowCardModal(true);
        return null;
      }
      if (selectedTenderKind === "credit_liability" && !hasCustomer) {
        toast.error("Please select a customer before using Store Credit");
        return null;
      }
      if (selectedMethodConfig.requires_reference && !draft.reference.trim()) {
        toast.error(
          `A reference is required for ${selectedMethodConfig.display_name} so finance can reconcile this payment.`,
        );
        return null;
      }

      const row = await recordTenderRow({
        tender_kind: selectedMethodConfig.tender_kind as PosTenderKind,
        method_key: selectedMethodConfig.method_key,
        provider_key: selectedMethodConfig.provider_key ?? null,
        amount: draftAmountNum,
        tendered_amount: draftAmountNum,
        change_given: 0,
        reference: draft.reference.trim() || null,
      });
      if (row) {
        resetDraftAfterCommit();
        const nextRows = [...tenderRows, row];
        const nextTotal = nextRows.reduce((s, r) => s + Number(r.amount), 0);
        if (opts.closeIfCovers && nextTotal >= effectiveTotal) finalizeWith(nextRows);
      }
      return row;
    },
    [
      selectedMethodConfig,
      selectedTenderKind,
      selectedProviderKey,
      draftAmountNum,
      draft.reference,
      cashRoundingSettings.enabled,
      roundedEffectiveTotal,
      effectiveTotal,
      totalApplied,
      tenderRows,
      isMpesaEnabled,
      hasCustomer,
      recordTenderRow,
      resetDraftAfterCommit,
      finalizeWith,
    ],
  );

  const handleAddTender = () => {
    void commitDraft({ closeIfCovers: false });
  };

  // Confirm is the terminal event. If a cash draft is pending and covers the
  // remaining balance, commit it in the same action (single-tender fast path).
  const handleConfirm = async () => {
    if (draftIsCash && draftAmountNum > 0 && draftCoversRemaining) {
      await commitDraft({ closeIfCovers: true });
      return;
    }
    if (remaining <= 0 && tenderRows.length > 0) {
      finalizeWith(tenderRows);
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
    const row = await recordTenderRow(cardAuthToTender(auth, pendingCardAmount));
    setShowCardModal(false);
    setPendingCardAmount(0);
    if (!row) return;
    resetDraftAfterCommit();
    const nextRows = [...tenderRows, row];
    const nextTotal = nextRows.reduce((s, r) => s + Number(r.amount), 0);
    if (nextTotal >= effectiveTotal) finalizeWith(nextRows);
  };

  const handleMpesaSuccess = async (receiptNumber: string) => {
    if (!mpesaWalletMethod) return;
    const row = await recordTenderRow({
      tender_kind: "wallet",
      method_key: mpesaWalletMethod.method_key,
      provider_key: mpesaWalletMethod.provider_key ?? "mpesa",
      amount: pendingMpesaAmount,
      tendered_amount: pendingMpesaAmount,
      change_given: 0,
      reference: receiptNumber,
    });
    setShowMpesaModal(false);
    setPendingMpesaAmount(0);
    if (!row) return;
    resetDraftAfterCommit();
    const nextRows = [...tenderRows, row];
    const nextTotal = nextRows.reduce((s, r) => s + Number(r.amount), 0);
    if (nextTotal >= effectiveTotal) finalizeWith(nextRows);
  };

  // Quick-fill chips — write to draft.amount only. Exact, next 10 / 50 / 100.
  const quickChipAmounts = useMemo(() => {
    const target = targetForDraft;
    const amounts = new Set<number>();
    amounts.add(Number(target.toFixed(2)));
    for (const round of [10, 50, 100, 500]) {
      const rounded = Math.ceil(target / round) * round;
      if (rounded > target) amounts.add(rounded);
    }
    return [...amounts].sort((a, b) => a - b).slice(0, 4);
  }, [targetForDraft]);

  const railCart = useCart();
  const tenderSummaryCart = useMemo(
    () => ({
      subtotal: railCart.subtotal,
      discount_amount: railCart.discount_amount,
      tax_amount: railCart.tax_amount,
      total: effectiveTotal,
    }),
    [railCart.subtotal, railCart.discount_amount, railCart.tax_amount, effectiveTotal],
  );

  const canConfirm =
    (remaining <= 0 && tenderRows.length > 0) || draftCoversRemaining;

  const confirmHelper = (() => {
    if (canConfirm) return null;
    if (tenderRows.length === 0 && draftAmountNum === 0)
      return "Enter an amount or pick a payment to enable Confirm";
    if (remaining > 0 && !draftCoversRemaining)
      return `Collect ${formatCurrency(remaining)} more to confirm`;
    return null;
  })();

  // Right-rail summary content, reused by the desktop aside and the
  // mobile bottom sheet. Keeps parity between viewports so nothing on
  // small screens is hidden information — just a different container.
  const rail = (
    <>
      <div className="border-b px-4 py-3">
        <p className="text-xs text-muted-foreground">POS Client</p>
        <p className="truncate text-sm font-semibold">
          {railCart.customer?.name ?? "Walk-in customer"}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <TransactionSummaryRail
          cart={tenderSummaryCart}
          appliedPromotions={appliedPromotions}
          formatCurrency={formatCurrency}
          size="md"
          totalLabel="Net Payable"
          totalOverride={effectiveTotal}
        />
        <div className="mt-4 space-y-1.5 text-sm">
          {tipAmount > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>Tip</span>
              <span>{formatCurrency(tipAmount)}</span>
            </div>
          )}
          <Separator className="my-2" />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Paid</span>
            <span className="font-medium tabular-nums">{formatCurrency(totalApplied)}</span>
          </div>
          {draftAmountNum > 0 && (
            <div className="flex justify-between text-primary">
              <span>
                Draft{selectedMethodConfig ? ` · ${selectedMethodConfig.display_name}` : ""}
              </span>
              <span className="font-medium tabular-nums">{formatCurrency(draftAmountNum)}</span>
            </div>
          )}
          {remaining > 0 ? (
            <div className="flex justify-between text-amber-600">
              <span>Remaining</span>
              <span className="font-medium tabular-nums">{formatCurrency(remaining)}</span>
            </div>
          ) : (
            <div className="flex justify-between text-green-600">
              <span>Change</span>
              <span className="font-medium tabular-nums">{formatCurrency(change)}</span>
            </div>
          )}
        </div>

        {payments.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Recorded</p>
            {payments.map((payment, index) => {
              const method = enabledPaymentMethods.find((m) => m.method_key === payment.method);
              const IconComponent = method?.icon ? iconMap[method.icon] : CreditCard;
              return (
                <div
                  key={index}
                  className="flex items-center justify-between gap-2 rounded-lg border p-2"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {IconComponent && <IconComponent className="h-4 w-4 flex-shrink-0" />}
                    <span className="truncate text-sm">{method?.display_name ?? payment.method}</span>
                    {payment.reference && (
                      <Badge variant="outline" className="hidden text-[10px] sm:inline-flex">
                        {payment.reference}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <span className="text-sm font-medium tabular-nums">
                      {formatCurrency(payment.amount)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => handleRemovePayment(index)}
                      disabled={isRecording}
                      aria-label="Remove tender"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t p-4">
        <Button
          className="h-14 w-full bg-green-600 text-base text-white hover:bg-green-700"
          onClick={handleConfirm}
          disabled={!canConfirm || isRecording}
          aria-label="Confirm payment"
        >
          <CheckCircle className="mr-2 h-5 w-5" />
          Confirm Payment
        </Button>
        {confirmHelper && (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">{confirmHelper}</p>
        )}
      </div>
    </>
  );

  // Context-aware panel: only render blocks that apply to the active
  // draft. When nothing applies, the whole panel collapses so the keypad
  // gets the freed vertical space. This is the "context-aware design"
  // half of the redesign.
  const showQuickChips = draftIsCash && quickChipAmounts.length > 0;
  const showReference = Boolean(selectedMethodConfig?.requires_reference);
  const showTip = typeof onTipChange === "function";
  const showCashRoundingNote =
    cashRoundingSettings.enabled && cashRoundingDiff !== 0 && draftIsCash;
  const showMpesaLookup =
    isMpesaEnabled &&
    selectedMethodConfig?.tender_kind === "wallet" &&
    selectedProviderKey === "mpesa";
  const hasContext =
    showQuickChips || showReference || showTip || showCashRoundingNote || showMpesaLookup;

  return (
    <section
      aria-labelledby="tender-workspace-title"
      className="absolute inset-0 z-40 flex flex-col bg-background"
    >
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label="Back to sale"
            className="shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1
            id="tender-workspace-title"
            className="truncate text-base font-semibold sm:text-xl"
          >
            Payment
            {splitPortionLabel && (
              <span className="ml-2 text-sm font-normal text-primary">{splitPortionLabel}</span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground sm:text-xs">
              Amount Due
            </p>
            <p className="text-lg font-bold tabular-nums sm:text-2xl">
              {formatCurrency(effectiveTotal)}
            </p>
          </div>
          {/* Mobile summary trigger — the right rail becomes a bottom sheet on <md. */}
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0 md:hidden"
                aria-label="Show payment summary"
              >
                <Receipt className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="flex h-[85vh] flex-col p-0">
              <SheetHeader className="px-4 pt-4">
                <SheetTitle>Payment summary</SheetTitle>
              </SheetHeader>
              <div className="flex min-h-0 flex-1 flex-col">{rail}</div>
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* LEFT — event input surface. flex column with keypad claiming
            remaining vertical space so nothing overflows. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4 sm:px-6">
              {/* Method row */}
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Payment Method
                </Label>
                <div className="flex flex-wrap gap-2">
                  <TooltipProvider delayDuration={150}>
                    {resolved.map((r) => {
                      const IconComponent = r.icon ? iconMap[r.icon] : CreditCard;
                      const isSelected = draft.methodKey === r.method_key;
                      const isReady = r.isReady;
                      const btn = (
                        <Button
                          key={r.method_key}
                          type="button"
                          variant={isSelected ? "default" : "outline"}
                          size="sm"
                          className={cn(
                            "h-11 gap-2 px-3 text-sm",
                            !isReady && "cursor-not-allowed opacity-50",
                          )}
                          disabled={!isReady}
                          aria-disabled={!isReady}
                          aria-pressed={isSelected}
                          onClick={() => isReady && selectMethod(r.method_key)}
                        >
                          {IconComponent && <IconComponent className="h-4 w-4" />}
                          <span>{r.display_name}</span>
                        </Button>
                      );
                      if (isReady) return btn;
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
                                className="mt-1 inline-block text-primary underline"
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
              </div>

              {/* Active-draft amount display */}
              <div className="rounded-xl border bg-muted/30 px-4 py-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Amount to Tender
                    {selectedMethodConfig && (
                      <span className="ml-2 normal-case text-muted-foreground/80">
                        · {selectedMethodConfig.display_name}
                      </span>
                    )}
                  </span>
                  {remaining > 0 && (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setDraftAmount(remaining.toFixed(2))}
                    >
                      Use remaining
                    </button>
                  )}
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-3xl font-bold tabular-nums sm:text-4xl">
                    {formatCurrency(draftAmountNum)}
                  </span>
                  {draftIsCash && draftAmountNum > effectiveTotal - totalApplied && (
                    <span className="text-xs text-green-600">
                      Change{" "}
                      {formatCurrency(
                        draftAmountNum - Math.max(0, effectiveTotal - totalApplied),
                      )}
                    </span>
                  )}
                </div>
              </div>

              {/* Context-aware block — collapses entirely when nothing applies. */}
              {hasContext && (
                <div className="space-y-2">
                  {showQuickChips && (
                    <div className="grid grid-cols-4 gap-2">
                      {quickChipAmounts.map((amt) => (
                        <Button
                          key={amt}
                          type="button"
                          variant="outline"
                          size="sm"
                          className={cn(
                            "h-10 text-sm tabular-nums",
                            draft.amount === amt.toFixed(2) && "border-primary",
                          )}
                          onClick={() => setDraftAmount(amt.toFixed(2))}
                        >
                          {formatCurrency(amt)}
                        </Button>
                      ))}
                    </div>
                  )}

                  {showReference && (
                    <Input
                      value={draft.reference}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, reference: e.target.value }))
                      }
                      placeholder={`Reference for ${selectedMethodConfig?.display_name ?? ""}`}
                      className="h-11 text-sm"
                    />
                  )}

                  {showMpesaLookup && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-10 w-full gap-2 text-sm text-[#4caf50]"
                      onClick={() => setShowC2BLookup(true)}
                      disabled={!posTransactionId}
                      title={!posTransactionId ? "Save the sale first to enable lookup" : undefined}
                    >
                      <Search className="h-4 w-4" />
                      Look up M-Pesa transaction
                    </Button>
                  )}

                  {showTip && (
                    <div className="flex items-center gap-2">
                      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                        Tip
                      </Label>
                      {[10, 15, 20].map((pct) => (
                        <Button
                          key={pct}
                          variant="outline"
                          size="sm"
                          className="h-8 flex-1 text-xs"
                          onClick={() => handleTipQuick(pct)}
                        >
                          {pct}%
                        </Button>
                      ))}
                      <Input
                        type="number"
                        step="0.01"
                        value={localTip}
                        onChange={(e) => {
                          setLocalTip(e.target.value);
                          onTipChange?.(parseFloat(e.target.value) || 0);
                        }}
                        placeholder="Custom"
                        className="h-8 w-24 text-xs"
                      />
                    </div>
                  )}

                  {showCashRoundingNote && (
                    <p className="text-xs text-muted-foreground">
                      Cash rounding: {cashRoundingDiff > 0 ? "+" : ""}
                      {formatCurrency(cashRoundingDiff)} → {formatCurrency(roundedEffectiveTotal)}
                    </p>
                  )}
                </div>
              )}

              {/* Keypad — fills remaining vertical space; keys scale to
                  container so laptops never overflow. */}
              <div className="flex min-h-[220px] flex-1 flex-col">
                <POSKeypad
                  value={draft.amount}
                  onChange={setDraftAmount}
                  onClear={() => setDraftAmount("")}
                  onBackspace={() => setDraftAmount(draft.amount.slice(0, -1))}
                />
              </div>

              {/* Add tender — commits the draft as one tender row */}
              <Button
                onClick={handleAddTender}
                disabled={
                  isRecording ||
                  !selectedMethodConfig ||
                  draftAmountNum <= 0 ||
                  (selectedTenderKind === "credit_liability" && !hasCustomer)
                }
                className="h-12 w-full text-sm font-semibold"
                variant="secondary"
              >
                Add Tender
              </Button>
            </div>
          )}
        </div>

        {/* RIGHT RAIL — desktop only. Mobile uses the bottom-sheet trigger in the header. */}
        <aside className="hidden w-80 flex-col border-l bg-card md:flex xl:w-96">
          {rail}
        </aside>
      </div>


      {/* Payment provider sub-modals — remain modal (wrap device-driver
          conversations, not workstation phases). */}
      <MpesaPaymentModal
        open={showMpesaModal}
        onOpenChange={setShowMpesaModal}
        amount={pendingMpesaAmount}
        posTransactionId={posTransactionId}
        onSuccess={handleMpesaSuccess}
        onCancel={() => {
          setShowMpesaModal(false);
          setPendingMpesaAmount(0);
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
        amount={pendingCardAmount}
        captureMode={
          (cardMethod?.capture_mode as "auth_only" | "auth_capture") ?? "auth_capture"
        }
        onSuccess={handleCardSuccess}
        onCancel={() => {
          setShowCardModal(false);
          setPendingCardAmount(0);
        }}
      />
    </section>
  );
}
