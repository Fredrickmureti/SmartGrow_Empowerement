/**
 * ReturnWorkspace — Phase-3d, route-owned surface for
 * `terminalState.phase === "return"`.
 *
 * Replaces `ReturnDialog` as the "Process Return" workstation. The
 * three cashier steps (search → items → confirm) run inside a
 * full-region `<section>` — no `<Dialog>` chrome — and every exit
 * dispatches `closeSide` so the reducer restores the previous phase
 * (`ready` or `held`).
 *
 * Sub-modals that wrap driver conversations rather than workstation
 * phases stay modal on purpose:
 *   - `ManagerOverrideDialog` — server-driven PIN capture. Modal is
 *     correct: it interrupts the return until an override is granted
 *     or the cashier abandons the attempt.
 *
 * Business logic is unchanged from the retired `ReturnDialog`; the
 * only structural differences are (1) the outer chrome and (2) the
 * exit dispatches. Every hook, every guard, every server call is
 * identical byte-for-byte.
 *
 * See `docs/architecture/POS_WORKSTATION_STATES.md` and the drift
 * guard at `src/__tests__/architecture.pos-workspace-dialogs.test.ts`.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Search,
  RotateCcw,
  Banknote,
  CreditCard,
  Gift,
  Minus,
  Plus,
  AlertCircle,
  ArrowLeft,
} from "lucide-react";
import { usePOSTransactionHistory, POSTransactionRecord } from "@/hooks/pos/usePOSTransactionHistory";
import { usePOSReturns } from "@/hooks/pos/usePOSReturns";
import { usePOSReturnReasons } from "@/hooks/pos/usePOSReturnReasons";
import { usePOSOriginalPayments } from "@/hooks/pos/usePOSOriginalPayments";
import { usePOSReturnableQty } from "@/hooks/pos/usePOSReturnableQty";
import { scanBus } from "@/services/pos/scanBus";
import { scanRouter } from "@/services/pos/scanRouter";
import { isOverrideRequiredError } from "@/hooks/pos/usePOSSecuritySettings";
import { useManagerOverride, OverrideAction } from "@/hooks/pos/useManagerOverride";
import { ManagerOverrideDialog } from "@/components/pos/ManagerOverrideDialog";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { format } from "date-fns";
import { useTerminalContext } from "../TerminalStateContext";

interface ReturnWorkspaceProps {
  registerId: string;
  shiftId: string;
}

export function ReturnWorkspace({ registerId, shiftId }: ReturnWorkspaceProps) {
  const { dispatch, state } = useTerminalContext();
  const { getTransactionDetails } = usePOSTransactionHistory();
  const { processReturn, prepareReturnItems } = usePOSReturns();
  const { data: reasons = [] } = usePOSReturnReasons();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // Stage 8.6: PIN/threshold gate is server-side via assert_manager_override.
  const { requestOverride, isVerifying } = useManagerOverride(currentOrg?.id, currentBusiness?.id);

  const active = state.phase === "return";
  const close = () => {
    if (state.phase === "return") dispatch({ kind: "op", op: "closeSide" });
  };

  const [step, setStep] = useState<"search" | "items" | "confirm">("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTransaction, setSelectedTransaction] = useState<POSTransactionRecord | null>(null);
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({});
  const [reasonIds, setReasonIds] = useState<Record<string, string>>({});
  const [reasonNotes, setReasonNotes] = useState<Record<string, string>>({});
  const [refundMethod, setRefundMethod] = useState<"cash" | "card" | "store_credit">("cash");
  const [notes, setNotes] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<POSTransactionRecord | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showManagerOverride, setShowManagerOverride] = useState(false);
  const [overrideAction, setOverrideAction] = useState<OverrideAction>("refund");

  // H3 — Receipt-scan path. When on the search step, a barcode burst
  // auto-populates the search box and runs lookup so the cashier never
  // types the receipt number for an in-hand receipt.
  const performLookup = async (token: string) => {
    setSearchQuery(token);
    setIsSearching(true);
    setSearchError(null);
    setSearchResult(null);
    try {
      const result = await getTransactionDetails(token);
      if (result && result.status === "completed" && result.transaction_type === "sale") {
        setSearchResult(result);
      } else if (result?.status === "voided") {
        setSearchError("This transaction has been voided");
      } else if (result?.transaction_type === "return") {
        setSearchError("Cannot return a return transaction");
      } else {
        setSearchError("Transaction not found");
      }
    } catch {
      setSearchError("Transaction not found. Please enter a valid transaction ID or number.");
    } finally {
      setIsSearching(false);
    }
  };

  // Subscribe to the central scanner kernel while on the search step.
  useEffect(() => {
    if (!active || step !== "search") return;
    return scanBus.on((event) => {
      if (scanRouter.wasConsumed(event)) return;
      void performLookup(event.code);
    });
  }, [active, step]);

  // Stage 4 closeout — original payments drive cross-tender detection.
  const { data: originalPayments = [] } = usePOSOriginalPayments(selectedTransaction?.id);
  // Stage K1 — server-truth remaining qty per line (sold − already-returned).
  const { data: remainingByItem = {} } = usePOSReturnableQty(selectedTransaction?.id);

  // Stage K1 — preselect refund tender to the largest original tender so
  // the cashier never starts in cross-tender mode by accident.
  useEffect(() => {
    if (!selectedTransaction || originalPayments.length === 0) return;
    const largest = [...originalPayments].sort((a, b) => b.amount - a.amount)[0];
    const m = largest.payment_method;
    if (m === "cash" || m === "card") {
      setRefundMethod(m);
    } else if (m === "voucher") {
      setRefundMethod("store_credit");
    }
  }, [selectedTransaction?.id, originalPayments.length]);

  // Reset local form when the workspace un-mounts (phase leaves "return").
  useEffect(() => {
    if (!active) {
      setStep("search");
      setSearchQuery("");
      setSelectedTransaction(null);
      setReturnQuantities({});
      setReasonIds({});
      setReasonNotes({});
      setRefundMethod("cash");
      setNotes("");
      setSearchResult(null);
      setSearchError(null);
    }
  }, [active]);

  // Escape returns to the caller's phase.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError(null);
    setSearchResult(null);
    try {
      const result = await getTransactionDetails(searchQuery);
      if (result && result.status === "completed" && result.transaction_type === "sale") {
        setSearchResult(result);
      } else if (result?.status === "voided") {
        setSearchError("This transaction has been voided");
      } else if (result?.transaction_type === "return") {
        setSearchError("Cannot return a return transaction");
      } else {
        setSearchError("Transaction not found");
      }
    } catch {
      setSearchError("Transaction not found. Please enter a valid transaction ID or number.");
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectTransaction = (tx: POSTransactionRecord) => {
    setSelectedTransaction(tx);
    const qty: Record<string, number> = {};
    tx.items?.forEach((item) => { qty[item.id] = 0; });
    setReturnQuantities(qty);
    setReasonIds({});
    setReasonNotes({});
    setStep("items");
  };

  const handleQuantityChange = (itemId: string, delta: number) => {
    const item = selectedTransaction?.items?.find((i) => i.id === itemId);
    if (!item) return;
    const cap = remainingByItem[itemId];
    const max = typeof cap === "number" ? cap : item.quantity;
    setReturnQuantities((prev) => {
      const current = prev[itemId] || 0;
      const newQty = Math.max(0, Math.min(max, current + delta));
      return { ...prev, [itemId]: newQty };
    });
  };

  const getTotalReturnAmount = () => {
    if (!selectedTransaction?.items) return 0;
    return selectedTransaction.items.reduce((sum, item) => {
      const qty = returnQuantities[item.id] || 0;
      const itemTotal = item.unit_price * qty;
      const tax = itemTotal * (item.tax_rate / 100);
      return sum + itemTotal + tax;
    }, 0);
  };

  // Lines with qty > 0 must have a reason; "other" requires a note
  const lineErrors: string[] = [];
  if (selectedTransaction?.items) {
    for (const item of selectedTransaction.items) {
      const q = returnQuantities[item.id] || 0;
      if (q <= 0) continue;
      const rId = reasonIds[item.id];
      if (!rId) {
        lineErrors.push(`Select a reason for "${item.description}"`);
        continue;
      }
      const r = reasons.find((x) => x.id === rId);
      if (r?.requires_note && !(reasonNotes[item.id] || "").trim()) {
        lineErrors.push(`Add a note for "${item.description}" (reason: ${r.label})`);
      }
    }
  }

  const hasSelectedItems = Object.values(returnQuantities).some((q) => q > 0);
  const canContinue = hasSelectedItems && lineErrors.length === 0;

  // Stage 4 closeout: refund tender vs original tender(s).
  // 'store_credit' is normalized to 'voucher' on the wire (see usePOSReturns).
  const refundTenderNormalized = refundMethod === "store_credit" ? "voucher" : refundMethod;
  const originalTenders = new Set(originalPayments.map((p) => p.payment_method));
  const isCrossTender =
    originalPayments.length > 0 && !originalTenders.has(refundTenderNormalized);

  const handleProcessReturn = async () => {
    if (!selectedTransaction?.items) return;
    setOverrideAction(isCrossTender ? "cross_tender_refund" : "refund");
    try {
      await executeReturn(null);
    } catch (err) {
      if (isOverrideRequiredError(err)) {
        setShowManagerOverride(true);
        return;
      }
    }
  };

  const executeReturn = async (overrideId: string | null) => {
    if (!selectedTransaction?.items) return;
    const returnItems = prepareReturnItems(
      selectedTransaction.items,
      returnQuantities,
      reasonIds,
      reasonNotes,
    );
    await processReturn.mutateAsync({
      register_id: registerId,
      shift_id: shiftId,
      original_transaction_id: selectedTransaction.id,
      items: returnItems,
      refund_method: refundMethod,
      notes,
      override_id: overrideId,
    });
    close();
  };

  const handleOverrideApprove = async (pin: string, reason?: string) => {
    const result = await requestOverride({
      action: overrideAction,
      pin,
      registerId,
      transactionId: selectedTransaction?.id,
      originalValue: getTotalReturnAmount(),
      reason:
        reason ||
        (isCrossTender
          ? `Cross-tender refund (${refundTenderNormalized}); original=${[...originalTenders].join("/") || "unknown"}`
          : notes),
    });
    setShowManagerOverride(false);
    void executeReturn(result.overrideId);
  };

  if (!active) return null;

  return (
    <>
      <Sheet open={active} onOpenChange={(v) => !v && close()}>
        <SheetContent
          side="right"
          className="w-full p-0 sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl flex flex-col"
        >
          <section
            aria-labelledby="return-workspace-title"
            className="flex-1 min-h-0 flex flex-col bg-background"
          >
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="icon" onClick={close} aria-label="Back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1
              id="return-workspace-title"
              className="flex items-center gap-2 text-lg font-semibold sm:text-xl truncate"
            >
              <RotateCcw className="h-5 w-5" />
              Process Return
            </h1>
          </div>
          <Button variant="outline" onClick={close}>
            Close
          </Button>
        </header>

        <ScrollArea className="flex-1 min-h-0">
          <div className="mx-auto w-full max-w-2xl px-4 py-4 sm:px-6 sm:py-6 space-y-4">
            {step === "search" && (
              <div className="space-y-3 sm:space-y-4">
                <div className="space-y-1.5 sm:space-y-2">
                  <Label className="text-xs sm:text-sm">Find Original Transaction</Label>
                  <div className="flex gap-2">
                    <Input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Transaction number or ID"
                      onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                      className="h-10 sm:h-9 text-base sm:text-sm"
                    />
                    <Button onClick={handleSearch} disabled={isSearching} className="h-10 sm:h-9 px-3">
                      <Search className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {searchError && (
                  <div className="flex items-center gap-2 p-2.5 sm:p-3 bg-destructive/10 text-destructive rounded-lg">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="text-xs sm:text-sm">{searchError}</span>
                  </div>
                )}

                {searchResult && (
                  <Button
                    variant="outline"
                    className="w-full h-auto py-3 sm:py-4 justify-start"
                    onClick={() => handleSelectTransaction(searchResult)}
                  >
                    <div className="text-left min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm truncate">{searchResult.transaction_number}</span>
                        <Badge variant="outline" className="text-[10px] sm:text-xs shrink-0">
                          {format(new Date(searchResult.created_at), "MMM d, h:mm a")}
                        </Badge>
                      </div>
                      <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                        {searchResult.items?.length || 0} items • {formatCurrency(searchResult.total)}
                      </p>
                    </div>
                  </Button>
                )}
              </div>
            )}

            {step === "items" && selectedTransaction && (
              <div className="space-y-3 sm:space-y-4">
                <div className="flex items-center justify-between">
                  <Button variant="ghost" size="sm" onClick={() => setStep("search")} className="h-8 px-2 text-xs sm:text-sm">
                    ← Back
                  </Button>
                  <Badge className="text-[10px] sm:text-xs">{selectedTransaction.transaction_number}</Badge>
                </div>

                <div className="space-y-2">
                  {selectedTransaction.items?.map((item) => {
                    const q = returnQuantities[item.id] || 0;
                    const reasonId = reasonIds[item.id] || "";
                    const r = reasons.find((x) => x.id === reasonId);
                    return (
                      <div key={item.id} className="border rounded-lg p-2.5 sm:p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-xs sm:text-sm truncate">{item.description}</p>
                            <p className="text-[10px] sm:text-sm text-muted-foreground">
                              {formatCurrency(item.unit_price)} × {item.quantity}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                            <Button
                              variant="outline" size="icon" className="h-7 w-7 sm:h-8 sm:w-8"
                              onClick={() => handleQuantityChange(item.id, -1)}
                              disabled={q === 0}
                            >
                              <Minus className="h-3 w-3" />
                            </Button>
                            <span className="w-6 sm:w-8 text-center font-medium text-sm">{q}</span>
                            <Button
                              variant="outline" size="icon" className="h-7 w-7 sm:h-8 sm:w-8"
                              onClick={() => handleQuantityChange(item.id, 1)}
                              disabled={q >= (remainingByItem[item.id] ?? item.quantity)}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>

                        {q > 0 && (
                          <div className="space-y-2">
                            <Select
                              value={reasonId}
                              onValueChange={(v) => setReasonIds((prev) => ({ ...prev, [item.id]: v }))}
                            >
                              <SelectTrigger className="h-9 text-xs sm:text-sm">
                                <SelectValue placeholder="Select reason…" />
                              </SelectTrigger>
                              <SelectContent>
                                {reasons.map((reason) => (
                                  <SelectItem key={reason.id} value={reason.id}>
                                    {reason.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {r?.requires_note && (
                              <Textarea
                                value={reasonNotes[item.id] || ""}
                                onChange={(e) =>
                                  setReasonNotes((prev) => ({ ...prev, [item.id]: e.target.value }))
                                }
                                placeholder="Explain the reason…"
                                rows={2}
                                className="text-xs sm:text-sm"
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {lineErrors.length > 0 && (
                  <div className="flex items-start gap-2 p-2.5 bg-destructive/10 text-destructive rounded-lg">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <ul className="text-xs sm:text-sm list-disc pl-4">
                      {lineErrors.slice(0, 3).map((err) => <li key={err}>{err}</li>)}
                    </ul>
                  </div>
                )}

                <div className="flex justify-between items-center p-2.5 sm:p-3 bg-muted/50 rounded-lg">
                  <span className="font-medium text-xs sm:text-sm">Refund Amount:</span>
                  <span className="text-lg sm:text-xl font-bold">{formatCurrency(getTotalReturnAmount())}</span>
                </div>

                <Button
                  className="w-full h-11"
                  onClick={() => setStep("confirm")}
                  disabled={!canContinue}
                >
                  Continue to Refund
                </Button>
              </div>
            )}

            {step === "confirm" && (
              <div className="space-y-3 sm:space-y-4">
                <Button variant="ghost" size="sm" onClick={() => setStep("items")} className="h-8 px-2 text-xs sm:text-sm">
                  ← Back
                </Button>

                <div className="p-3 sm:p-4 bg-muted/50 rounded-lg text-center">
                  <p className="text-xs sm:text-sm text-muted-foreground">Refund Amount</p>
                  <p className="text-2xl sm:text-3xl font-bold">{formatCurrency(getTotalReturnAmount())}</p>
                </div>

                <div className="space-y-1.5 sm:space-y-2">
                  <Label className="text-xs sm:text-sm">Refund Method</Label>
                  <RadioGroup
                    value={refundMethod}
                    onValueChange={(v) => setRefundMethod(v as typeof refundMethod)}
                    className="grid grid-cols-3 gap-1.5 sm:gap-2"
                  >
                    <Label className={`flex flex-col items-center gap-1 sm:gap-2 p-2 sm:p-3 border rounded-lg cursor-pointer ${refundMethod === "cash" ? "border-primary bg-primary/5" : ""}`}>
                      <RadioGroupItem value="cash" className="sr-only" />
                      <Banknote className="h-4 w-4 sm:h-5 sm:w-5" />
                      <span className="text-[10px] sm:text-sm">Cash</span>
                    </Label>
                    <Label className={`flex flex-col items-center gap-1 sm:gap-2 p-2 sm:p-3 border rounded-lg cursor-pointer ${refundMethod === "card" ? "border-primary bg-primary/5" : ""}`}>
                      <RadioGroupItem value="card" className="sr-only" />
                      <CreditCard className="h-4 w-4 sm:h-5 sm:w-5" />
                      <span className="text-[10px] sm:text-sm">Card</span>
                    </Label>
                    <Label className={`flex flex-col items-center gap-1 sm:gap-2 p-2 sm:p-3 border rounded-lg cursor-pointer ${refundMethod === "store_credit" ? "border-primary bg-primary/5" : ""}`}>
                      <RadioGroupItem value="store_credit" className="sr-only" />
                      <Gift className="h-4 w-4 sm:h-5 sm:w-5" />
                      <span className="text-[10px] sm:text-sm">Credit</span>
                    </Label>
                  </RadioGroup>
                </div>

                <div className="space-y-1.5 sm:space-y-2">
                  <Label className="text-xs sm:text-sm">Return Notes (Optional)</Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Additional context…"
                    rows={2}
                    className="text-sm"
                  />
                </div>

                {isCrossTender && (
                  <div className="flex items-start gap-2 p-2.5 bg-amber-500/10 text-amber-700 dark:text-amber-300 rounded-lg">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <p className="text-[11px] sm:text-xs">
                      Cross-tender refund: original sale paid by{" "}
                      <strong>{[...originalTenders].join(", ") || "unknown"}</strong>, refunding as{" "}
                      <strong>{refundTenderNormalized}</strong>. Manager approval required.
                    </p>
                  </div>
                )}

                <Button
                  className="w-full h-11"
                  onClick={handleProcessReturn}
                  disabled={processReturn.isPending}
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Process Return
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>
      </section>

      <ManagerOverrideDialog
        open={showManagerOverride}
        onOpenChange={setShowManagerOverride}
        action={overrideAction}
        originalValue={getTotalReturnAmount()}
        onApprove={handleOverrideApprove}
        isVerifying={isVerifying}
      />
    </>
  );
}

export default ReturnWorkspace;
