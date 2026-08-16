import { useState, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { usePOSShifts, POSShift } from "@/hooks/pos/usePOSShifts";
import { AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { useCurrency } from "@/hooks/useCurrency";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { CashDenominationCounter } from "./CashDenominationCounter";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { usePOSSound } from "@/hooks/pos/usePOSSound";

interface CloseShiftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shift: POSShift;
  onShiftClosed: () => void;
}

export function CloseShiftDialog({ open, onOpenChange, shift, onShiftClosed }: CloseShiftDialogProps) {
  const { closeShift } = usePOSShifts();
  const { formatCurrency, getCurrencySymbol } = useCurrency();
  const { currentBusiness } = useBusinesses();
  const { settings } = usePOSSettings();
  const sound = usePOSSound();

  // Currency comes from the legal entity (business), not the workspace
  const orgCurrency = currentBusiness?.base_currency || "DEFAULT";
  const denominationProfile = (() => {
    const setting = settings?.find(s => s.setting_key === "denomination_profile");
    if (setting?.setting_value && typeof setting.setting_value === 'object' && !Array.isArray(setting.setting_value)) {
      const profile = setting.setting_value as Record<string, unknown>;
      if (Array.isArray(profile.denominations)) return profile.denominations as number[];
    }
    return undefined;
  })();
  
  const [actualCash, setActualCash] = useState("");
  const [notes, setNotes] = useState("");
  const [isBlindClose, setIsBlindClose] = useState(false);
  const [isPostingGL, setIsPostingGL] = useState(false);

  // Stage 6.1: read expected cash from v_pos_cash_expected (canonical source)
  const [expectedBreakdown, setExpectedBreakdown] = useState<{
    opening_cash: number; cash_sales: number; cash_refunds: number;
    movements_net: number; expected_cash_computed: number;
  } | null>(null);

  // Stage 7: gate + variance + manager override
  const [gateReasons, setGateReasons] = useState<Array<{ code: string; message: string }>>([]);
  const [gateLoading, setGateLoading] = useState(false);
  const [denominationCounted, setDenominationCounted] = useState(false);
  const [managerPin, setManagerPin] = useState("");
  // `null` = not yet resolved; a numeric value (incl. 0) = authoritative.
  const [varianceThreshold, setVarianceThreshold] = useState<number | null>(null);
  // Populated when the DB backstop trigger returns `override_required` so we
  // can switch the dialog into "PIN required" mode using the server-resolved
  // threshold/variance, without losing the cashier's count.
  const [serverOverrideRequired, setServerOverrideRequired] = useState<
    { threshold: number; variance: number } | null
  >(null);

  useEffect(() => {
    if (!open || !shift?.id) return;
    let cancelled = false;
    setGateLoading(true);
    setServerOverrideRequired(null);
    (async () => {
      // Variance threshold lives in pos_override_matrix (action='shift_variance').
      // Falls back to the shift's stamped tolerance if the org has no matrix row,
      // so the UI never silently skips enforcement.
      const [viewRes, gateRes, matrixRes] = await Promise.all([
        supabase.from("v_pos_cash_expected" as any)
          .select("opening_cash, cash_sales, cash_refunds, movements_net, expected_cash_computed")
          .eq("shift_id", shift.id).maybeSingle(),
        // Phase 9: `pos_till_close_blockers` wraps the legacy gate and adds the
        // `open_payment_sessions` reason (a session still holding tendered money).
        // The DB trigger `trg_pos_till_close_payment_guard` enforces the same
        // boundary regardless of caller — this call is what lets the cashier see
        // it before submitting instead of after.
        supabase.rpc("pos_till_close_blockers" as any, { p_till_id: shift.id } as any),
        supabase.from("pos_override_matrix" as any)
          .select("threshold_amount")
          .eq("organization_id", shift.organization_id)
          .eq("action", "shift_variance")
          .eq("is_active", true)
          .order("business_id", { nullsFirst: false })
          .limit(1).maybeSingle(),
      ]);
      if (cancelled) return;
      if (viewRes.data) setExpectedBreakdown(viewRes.data as any);
      if (gateRes.data && (gateRes.data as any).reasons) {
        setGateReasons(((gateRes.data as any).reasons || []) as any);
      }
      if (matrixRes.data) {
        setVarianceThreshold(Number((matrixRes.data as any).threshold_amount) || 0);
      } else {
        const stamped = (shift as any).cash_variance_tolerance;
        setVarianceThreshold(typeof stamped === "number" ? stamped : 0);
      }
      setGateLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, shift?.id, shift?.organization_id, shift]);

  const handleDenominationTotal = useCallback((total: number) => {
    if (total > 0) {
      setActualCash(total.toString());
      setDenominationCounted(true);
    }
  }, []);

  const expectedCash = expectedBreakdown?.expected_cash_computed ?? (shift.expected_cash || 0);
  const actualCashNum = isBlindClose ? 0 : (parseFloat(actualCash) || 0);
  const difference = isBlindClose ? 0 : (actualCashNum - expectedCash);
  const currencySymbol = getCurrencySymbol();
  // Trust the server-resolved threshold once the trigger has spoken; otherwise
  // use the matrix/stamped value. Threshold of 0 is a valid zero-tolerance
  // policy, so only `null` (unresolved) suppresses enforcement here.
  const effectiveThreshold = serverOverrideRequired?.threshold ?? varianceThreshold;
  const needsManagerOverride =
    !isBlindClose &&
    effectiveThreshold !== null &&
    Math.abs(difference) > effectiveThreshold;
  const hasBlockers = gateReasons.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let overrideId: string | null = null;
    if (needsManagerOverride) {
      if (!managerPin || managerPin.length < 4) {
        toast.error("Manager PIN is required for variance above threshold");
        return;
      }
      // Verify PIN and create an override scoped to this shift
      const { data: pins } = await supabase
        .from("pos_manager_pins")
        .select("user_id")
        .eq("organization_id", shift.organization_id)
        .eq("business_id", shift.business_id)
        .eq("is_active", true);
      let managerUserId: string | null = null;
      for (const p of pins || []) {
        const { data: ok } = await supabase.rpc("verify_manager_pin" as any, {
          p_manager_id: (p as any).user_id,
          p_organization_id: shift.organization_id,
          p_business_id: shift.business_id,
          p_pin: managerPin,
        } as any);
        if (ok) { managerUserId = (p as any).user_id; break; }
      }
      if (!managerUserId) {
        toast.error("Invalid manager PIN");
        return;
      }
      const { data: ov, error: ovErr } = await supabase
        .from("pos_manager_overrides")
        .insert({
          organization_id: shift.organization_id,
          business_id: shift.business_id,
          manager_id: managerUserId,
          shift_id: shift.id,
          register_id: shift.register_id,
          override_type: "shift_variance",
          original_value: expectedCash,
          new_value: actualCashNum,
          override_reason: notes || "Shift close variance",
          status: "approved",
        } as any)
        .select()
        .single();
      if (ovErr || !ov) {
        toast.error("Could not create manager override");
        return;
      }
      overrideId = (ov as any).id;
    }

    try {
      await closeShift.mutateAsync({
        shift_id: shift.id,
        actual_cash: isBlindClose ? expectedCash : actualCashNum,
        notes: `${isBlindClose ? "[BLIND CLOSE] " : ""}${notes}`.trim() || undefined,
        blind_close: isBlindClose,
        manager_override_id: overrideId,
        denomination_counted: denominationCounted,
      });
      sound.play("shift_close");
    } catch (err) {
      sound.play("error");
      // Detect the structured override_required error raised by the
      // close RPC's assert_manager_override() or by the backstop trigger,
      // and switch the dialog into PIN-prompt mode using the server's
      // authoritative numbers instead of bubbling a raw DB toast.
      const anyErr = err as { code?: string; message?: string; details?: string; hint?: string };
      const isOverrideRequired =
        anyErr?.code === "42501" ||
        (typeof anyErr?.message === "string" &&
          /override_required|exceeds tolerance/i.test(anyErr.message));
      if (isOverrideRequired) {
        let threshold: number | null = null;
        let variance: number | null = null;
        if (anyErr.details) {
          try {
            const parsed = JSON.parse(anyErr.details);
            if (typeof parsed.threshold === "number") threshold = parsed.threshold;
            else if (parsed.threshold != null) threshold = Number(parsed.threshold);
            if (typeof parsed.variance === "number") variance = parsed.variance;
            else if (parsed.variance != null) variance = Number(parsed.variance);
          } catch { /* fall through to UI-known values */ }
        }
        setServerOverrideRequired({
          threshold: threshold ?? effectiveThreshold ?? 0,
          variance: variance ?? difference,
        });
        toast.error(
          anyErr.hint ||
            "Manager override required to close this shift. Enter a manager PIN below.",
        );
        return; // keep dialog open; cashier can type the PIN and resubmit
      }
      throw err;
    }

    setIsPostingGL(false);
    setActualCash("");
    setNotes("");
    setManagerPin("");
    setServerOverrideRequired(null);
    onShiftClosed();
  };

  const isSubmitting = closeShift.isPending || isPostingGL;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg">Close Shift</DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            Count your cash drawer and enter the closing amount.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-3 sm:space-y-4">
          {/* Shift Summary */}
          <div className="bg-muted/50 rounded-lg p-3 sm:p-4 space-y-1.5 sm:space-y-2">
            <div className="flex justify-between text-xs sm:text-sm">
              <span className="text-muted-foreground">Shift Number</span>
              <span className="font-medium">{shift.shift_number}</span>
            </div>
            <div className="flex justify-between text-xs sm:text-sm">
              <span className="text-muted-foreground">Started</span>
              <span>{format(new Date(shift.opened_at), "MMM d, h:mm a")}</span>
            </div>
            <div className="flex justify-between text-xs sm:text-sm">
              <span className="text-muted-foreground">Opening Cash</span>
              <span>{formatCurrency(shift.opening_cash || 0)}</span>
            </div>
            <Separator />
            {expectedBreakdown && (
              <div className="space-y-1 text-[11px] sm:text-xs text-muted-foreground">
                <div className="flex justify-between"><span>+ Cash sales</span><span>{formatCurrency(expectedBreakdown.cash_sales)}</span></div>
                <div className="flex justify-between"><span>− Cash refunds</span><span>{formatCurrency(expectedBreakdown.cash_refunds)}</span></div>
                <div className="flex justify-between"><span>± Cash movements (net)</span><span>{formatCurrency(expectedBreakdown.movements_net)}</span></div>
              </div>
            )}
            <div className="flex justify-between font-medium text-sm sm:text-base">
              <span>Expected Cash</span>
              <span>{formatCurrency(expectedCash)}</span>
            </div>
          </div>

          {/* Stage 7: blocked-close reasons */}
          {hasBlockers && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-1.5">
              <div className="flex items-center gap-2 text-destructive text-xs sm:text-sm font-medium">
                <AlertTriangle className="h-4 w-4" /> Close blocked
              </div>
              <ul className="list-disc pl-5 text-xs text-destructive/90 space-y-0.5">
                {gateReasons.map((r) => (
                  <li key={r.code}>{r.message}</li>
                ))}
              </ul>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-4">
            {/* Blind Close Toggle */}
            <div className="flex items-center justify-between p-2 border rounded-lg">
              <div>
                <p className="text-xs sm:text-sm font-medium">Blind Close</p>
                <p className="text-[10px] sm:text-xs text-muted-foreground">Close without counting cash</p>
              </div>
              <Button
                type="button"
                variant={isBlindClose ? "default" : "outline"}
                size="sm"
                onClick={() => setIsBlindClose(!isBlindClose)}
              >
                {isBlindClose ? "On" : "Off"}
              </Button>
            </div>

            {!isBlindClose && (
            <div className="space-y-1.5 sm:space-y-2">
              <Label htmlFor="actual_cash" className="text-xs sm:text-sm">Actual Cash in Drawer</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">
                  {currencySymbol}
                </span>
                <Input
                  id="actual_cash"
                  type="number"
                  step="0.01"
                  min="0"
                  value={actualCash}
                  onChange={(e) => setActualCash(e.target.value)}
                  className="pl-10 h-10 sm:h-9 text-base sm:text-sm"
                  placeholder="0.00"
                  autoFocus
                />
              </div>
              <CashDenominationCounter 
                onTotalChange={handleDenominationTotal} 
                currencyCode={orgCurrency}
                configDenominations={denominationProfile}
              />
            </div>
            )}

            {/* Difference Display */}
            {!isBlindClose && actualCash && (
              <div className={`rounded-lg p-2.5 sm:p-3 flex items-center gap-2 sm:gap-3 ${
                difference === 0 
                  ? "bg-green-500/10 text-green-600" 
                  : difference > 0 
                    ? "bg-blue-500/10 text-blue-600"
                    : "bg-red-500/10 text-red-600"
              }`}>
                {difference === 0 ? (
                  <CheckCircle className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" />
                ) : (
                  <AlertTriangle className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" />
                )}
                <div>
                  <p className="font-medium text-xs sm:text-sm">
                    {difference === 0 
                      ? "Perfect balance!" 
                      : difference > 0 
                        ? `Over by ${formatCurrency(difference)}`
                        : `Short by ${formatCurrency(Math.abs(difference))}`
                    }
                  </p>
                </div>
              </div>
            )}
            
            <div className="space-y-1.5 sm:space-y-2">
              <Label htmlFor="notes" className="text-xs sm:text-sm">Notes (Optional)</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any notes about the shift..."
                rows={2}
                className="text-sm"
              />
            </div>
            
            {needsManagerOverride && (
              <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <Label htmlFor="manager_pin" className="text-xs sm:text-sm text-amber-700">
                  Manager PIN required — variance{" "}
                  {formatCurrency(
                    Math.abs(serverOverrideRequired?.variance ?? difference),
                  )}{" "}
                  exceeds tolerance{" "}
                  {formatCurrency(effectiveThreshold ?? 0)}
                </Label>
                <Input
                  id="manager_pin"
                  type="password"
                  inputMode="numeric"
                  value={managerPin}
                  onChange={(e) => setManagerPin(e.target.value)}
                  placeholder="Enter manager PIN"
                  className="h-10 sm:h-9 text-sm"
                />
              </div>
            )}

            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  isSubmitting || hasBlockers || gateLoading ||
                  (!isBlindClose && !actualCash) ||
                  (needsManagerOverride && managerPin.length < 4)
                }
                variant={!isBlindClose && difference !== 0 ? "destructive" : "default"}
                className="w-full sm:w-auto"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {isPostingGL ? "Posting to Accounting..." : "Closing..."}
                  </>
                ) : isBlindClose ? "Blind Close Shift" : "Close Shift"}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
