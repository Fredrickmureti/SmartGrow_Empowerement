import { useState, useMemo, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Wallet,
  HandCoins,
  Clock,
  ShieldAlert,
  Banknote,
  Coins,
  RefreshCw,
} from "lucide-react";
import { usePOSCashDrawer, CashMovementType } from "@/hooks/pos/usePOSCashDrawer";
import { usePOSCashMovementTypes, CashMovementTypeConfig } from "@/hooks/pos/usePOSCashMovementTypes";
// Stage 8.6: PIN/threshold gate moved to pos_override_matrix (server-side).
import { useManagerOverride } from "@/hooks/pos/useManagerOverride";
import { ManagerOverrideDialog } from "./ManagerOverrideDialog";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useCurrency } from "@/hooks/useCurrency";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { usePOSSound } from "@/hooks/pos/usePOSSound";
import { CashDenominationCounter } from "./CashDenominationCounter";

interface CashDrawerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shiftId: string;
  registerId: string;
  expectedCash: number;
}

const ICONS: Record<CashMovementType, React.ElementType> = {
  opening_float: Wallet,
  cash_in: ArrowDownCircle,
  cash_out: ArrowUpCircle,
  float: Wallet,
  pickup: HandCoins,
  drop: HandCoins,
  safe_drop: ShieldAlert,
  bank_deposit: Banknote,
  petty_cash_out: Coins,
  correction: RefreshCw,
};

const POSITIVE: CashMovementType[] = ["opening_float", "cash_in", "float", "correction"];

export function CashDrawerDialog({
  open,
  onOpenChange,
  shiftId,
  registerId,
  expectedCash,
}: CashDrawerDialogProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency, getCurrencySymbol } = useCurrency();
  const { movements, isLoading, addMovement, totalCashIn, totalCashOut } =
    usePOSCashDrawer(shiftId);
  const { data: typeConfigs = [], isLoading: typesLoading } = usePOSCashMovementTypes();
  // settings hook removed — server-side matrix is the source of truth
  const { requestOverride, isVerifying } = useManagerOverride();
  const sound = usePOSSound();

  const [activeTab, setActiveTab] = useState("add");
  const [movementType, setMovementType] = useState<CashMovementType>("cash_in");
  const [amount, setAmount] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [notes, setNotes] = useState("");
  const [showOverrideDialog, setShowOverrideDialog] = useState(false);

  const selectedConfig: CashMovementTypeConfig | undefined = useMemo(
    () => typeConfigs.find((t) => t.movement_type === movementType),
    [typeConfigs, movementType]
  );

  const numericAmount = parseFloat(amount) || 0;

  // Stage 8.6: per-action threshold lives in pos_override_matrix and is enforced
  // by assert_manager_override server-side. Client only handles the legacy
  // requires_manager_default boolean for type-level mandatory PIN, plus opens
  // the PIN dialog reactively on `override_required` from the RPC.
  const requiresManager = !!selectedConfig?.requires_manager_default;

  // L2 — threshold-based reason gating. When the configured type sets a
  // `reason_required_above` value and the entered amount is below it, the
  // cashier does NOT have to type/pick a reason: we substitute the default
  // preset (or a sane fallback) so the audit row still has a value.
  const cfgReasonRequired = !!selectedConfig?.requires_reason;
  const reasonThreshold = selectedConfig?.reason_required_above ?? null;
  const reasonGatedBelowThreshold =
    reasonThreshold !== null && numericAmount > 0 && numericAmount < reasonThreshold;
  const reasonRequired = cfgReasonRequired && !reasonGatedBelowThreshold;

  // Stage J — preset chips replace blind typing. The configured presets array
  // is tap-to-fill; "Other" unlocks the free-text field. When no presets are
  // configured the dialog falls back to free-text only (legacy behavior).
  const presets = selectedConfig?.reason_presets ?? [];
  const hasPresets = presets.length > 0;
  const isOtherSelected = reasonCode === "Other";
  const reasonInvalid =
    reasonRequired && (
      reasonCode.trim() === "" ||
      (hasPresets && isOtherSelected && notes.trim() === "")
    );

  // L2 — quick-amount chips. One-tap fills the amount; cashier never types
  // for a £20 float top-up.
  const quickAmounts = selectedConfig?.quick_amounts ?? [];

  // Stage J — denomination quick-count. When the type opts in, the cashier
  // taps coin/note counts and the amount is computed; no typing required.
  const quickCountEnabled = !!selectedConfig?.quick_count_enabled;

  // Reset transient input when the cashier switches type so a leftover preset
  // from a different type doesn't silently submit.
  useEffect(() => {
    setReasonCode("");
    setNotes("");
    setAmount("");
  }, [movementType]);

  const submitMovement = async (overrideId?: string) => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    if (numericAmount <= 0 || reasonInvalid) return;

    // When 'Other' is chosen we promote the typed note into the reason_code
    // so reports can group by canonical reason and still show the detail.
    // L2 — when below threshold, substitute a default reason so the audit
    // row is still meaningful but the cashier wasn't forced to type anything.
    const fallbackReason =
      hasPresets ? presets[0] : `${selectedConfig?.label ?? movementType} (auto)`;
    const effectiveReason =
      hasPresets && isOtherSelected
        ? `Other: ${notes.trim()}`
        : reasonCode || (reasonGatedBelowThreshold ? fallbackReason : "");

    await addMovement.mutateAsync({
      organization_id: currentOrg.id,
      business_id: currentBusiness.id,
      shift_id: shiftId,
      register_id: registerId,
      movement_type: movementType,
      amount: numericAmount,
      reason_code: effectiveReason || undefined,
      notes: notes || undefined,
      override_id: overrideId,
    });
    sound.play("cash_drawer_open");
    setAmount("");
    setReasonCode("");
    setNotes("");
  };

  const handleSubmit = async () => {
    // L2 — manager-required-above threshold from the type config overrides
    // the legacy boolean when the amount exceeds it.
    const mgrThreshold = selectedConfig?.manager_required_above ?? null;
    const exceedsMgrThreshold =
      mgrThreshold !== null && numericAmount > mgrThreshold;
    if (requiresManager || exceedsMgrThreshold) {
      setShowOverrideDialog(true);
      return;
    }
    await submitMovement();
  };

  const handleOverrideApproval = async (pin: string, overrideReason?: string) => {
    const res: any = await requestOverride({
      action: "cash_drop",
      pin,
      registerId,
      shiftId,
      originalValue: 0,
      newValue: numericAmount,
      reason:
        overrideReason ||
        `Cash ${movementType.replace(/_/g, " ")}${reasonCode ? ` — ${reasonCode}` : ""}`,
    });
    setShowOverrideDialog(false);
    const overrideId = res?.override_id || res?.id;
    await submitMovement(overrideId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Wallet className="h-5 w-5" />
            Cash Drawer
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 p-2 sm:p-3 bg-muted/50 rounded-lg">
          <div className="flex sm:flex-col items-center justify-between sm:text-center min-w-0 gap-1">
            <p className="text-xs text-muted-foreground">Expected</p>
            <p className="text-sm sm:text-lg font-semibold break-all">{formatCurrency(expectedCash)}</p>
          </div>
          <div className="flex sm:flex-col items-center justify-between sm:text-center min-w-0 gap-1">
            <p className="text-xs text-muted-foreground">Cash In</p>
            <p className="text-sm sm:text-lg font-semibold text-green-600 break-all">+{formatCurrency(totalCashIn)}</p>
          </div>
          <div className="flex sm:flex-col items-center justify-between sm:text-center min-w-0 gap-1">
            <p className="text-xs text-muted-foreground">Cash Out</p>
            <p className="text-sm sm:text-lg font-semibold text-red-600 break-all">-{formatCurrency(totalCashOut)}</p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="add" className="text-xs sm:text-sm">Add Movement</TabsTrigger>
            <TabsTrigger value="history" className="text-xs sm:text-sm">History</TabsTrigger>
          </TabsList>

          <TabsContent value="add" className="space-y-3 sm:space-y-4">
            {/* Dynamic type grid driven by pos_cash_movement_types */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {typesLoading ? (
                <div className="col-span-full text-xs text-muted-foreground">Loading types…</div>
              ) : (
                typeConfigs.map((t) => {
                  const Icon = ICONS[t.movement_type] ?? Wallet;
                  const positive = POSITIVE.includes(t.movement_type);
                  return (
                    <Button
                      key={t.id}
                      variant={movementType === t.movement_type ? "default" : "outline"}
                      className="h-auto py-2 flex-col min-h-[60px]"
                      onClick={() => setMovementType(t.movement_type)}
                    >
                      <Icon
                        className={cn(
                          "h-4 w-4 sm:h-5 sm:w-5 mb-1",
                          movementType !== t.movement_type &&
                            (positive ? "text-green-500" : "text-red-500")
                        )}
                      />
                      <span className="text-xs leading-tight">{t.label}</span>
                      {t.requires_manager_default && (
                        <Badge variant="secondary" className="mt-1 text-[10px] px-1 py-0">PIN</Badge>
                      )}
                    </Button>
                  );
                })
              )}
            </div>

            {/* Stage J — Amount: denomination quick-count when the type
                opts in, otherwise a single numeric input. The cashier
                never types a number for opening_float / pickup / drop /
                deposit unless they explicitly disable quick-count for
                this type in POS settings. */}
            <div className="space-y-1.5">
              <Label className="text-xs sm:text-sm">Amount</Label>
              {quickCountEnabled ? (
                <div className="rounded-md border p-2">
                  <CashDenominationCounter
                    onTotalChange={(t) => setAmount(String(t))}
                  />
                  <div className="mt-2 flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Counted total</span>
                    <span className="font-semibold">{formatCurrency(numericAmount)}</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">
                      {getCurrencySymbol()}
                    </span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      className="pl-10 h-10 sm:h-9"
                    />
                  </div>
                  {/* L2 — one-tap quick-amount chips so a busy cashier never
                      types for the common amounts. Per-type, configured in DB. */}
                  {quickAmounts.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {quickAmounts.map((qa) => (
                        <Button
                          key={qa}
                          type="button"
                          size="sm"
                          variant={numericAmount === qa ? "default" : "outline"}
                          onClick={() => setAmount(String(qa))}
                          className="h-8 text-xs px-2.5"
                        >
                          {formatCurrency(qa)}
                        </Button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* L2 — when the entered amount is below the configured
                `reason_required_above` threshold the reason field is hidden
                entirely. The submit handler substitutes the default preset
                so audit rows still carry a value. Above threshold the Stage J
                preset chips / free-text input behave exactly as before. */}
            {reasonGatedBelowThreshold ? (
              <p className="text-xs text-muted-foreground">
                Reason auto-filled for small {selectedConfig?.label?.toLowerCase() ?? "movement"}s
                (below {formatCurrency(reasonThreshold ?? 0)}).
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs sm:text-sm">
                  Reason {reasonRequired && <span className="text-destructive">*</span>}
                </Label>
                {hasPresets ? (
                  <div className="flex flex-wrap gap-1.5">
                    {presets.map((p) => (
                      <Button
                        key={p}
                        type="button"
                        size="sm"
                        variant={reasonCode === p ? "default" : "outline"}
                        onClick={() => setReasonCode(p)}
                        className="h-8 text-xs"
                      >
                        {p}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Input
                    value={reasonCode}
                    onChange={(e) => setReasonCode(e.target.value)}
                    placeholder={reasonRequired ? "Required (e.g. Bank run, Petty cash)" : "Optional"}
                    className={cn("h-10 sm:h-9", reasonInvalid && "border-destructive")}
                  />
                )}
              </div>
            )}

            {/* Notes are optional unless the cashier picked the "Other"
                preset for a reason-required type — in which case the note
                IS the reason and must be filled in. */}
            {!reasonGatedBelowThreshold && (!hasPresets || isOtherSelected) && (
              <div className="space-y-1.5">
                <Label className="text-xs sm:text-sm">
                  Notes {hasPresets && isOtherSelected && reasonRequired && (
                    <span className="text-destructive">*</span>
                  )}
                </Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={
                    hasPresets && isOtherSelected
                      ? "Describe the reason"
                      : "Additional details…"
                  }
                  rows={2}
                  className={cn(
                    "text-sm",
                    hasPresets && isOtherSelected && reasonRequired && notes.trim() === "" && "border-destructive",
                  )}
                />
              </div>
            )}

            {requiresManager && (
              <p className="text-xs text-amber-600 flex items-center gap-1">
                <ShieldAlert className="h-3 w-3" /> Manager approval required to confirm this movement.
              </p>
            )}

            <Button
              className="w-full h-10 sm:h-9 text-sm"
              onClick={handleSubmit}
              disabled={
                numericAmount <= 0 ||
                reasonInvalid ||
                addMovement.isPending ||
                !selectedConfig
              }
            >
              {requiresManager ? "Request Manager Approval" : `Confirm ${selectedConfig?.label ?? ""}`}
            </Button>
          </TabsContent>

          <TabsContent value="history">
            <ScrollArea className="h-[300px]">
              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />
                  ))}
                </div>
              ) : movements.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Clock className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  <p>No cash movements this shift</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {movements.map((m) => {
                    const Icon = ICONS[m.movement_type] ?? Wallet;
                    const positive = POSITIVE.includes(m.movement_type);
                    return (
                      <div
                        key={m.id}
                        className="flex items-center justify-between p-3 border rounded-lg"
                      >
                        <div className="flex items-center gap-3">
                          <Icon className={cn("h-4 w-4", positive ? "text-green-500" : "text-red-500")} />
                          <div>
                            <p className="font-medium text-sm capitalize">
                              {m.movement_type.replace(/_/g, " ")}
                            </p>
                            {(m.reason_code || m.reason) && (
                              <p className="text-xs text-muted-foreground">
                                {m.reason_code || m.reason}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <p className={cn("font-semibold", positive ? "text-green-600" : "text-red-600")}>
                            {positive ? "+" : "-"}
                            {formatCurrency(m.amount)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(m.performed_at), "h:mm a")}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <ManagerOverrideDialog
          open={showOverrideDialog}
          onOpenChange={setShowOverrideDialog}
          action="cash_drop"
          originalValue={0}
          newValue={numericAmount}
          onApprove={handleOverrideApproval}
          isVerifying={isVerifying}
        />
      </DialogContent>
    </Dialog>
  );
}
