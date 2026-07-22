/**
 * Wave 2 · Phase C-3.3 — Post-commit card lifecycle UI.
 *
 * Renders Capture / Void / Reverse buttons for a single
 * `pos_transaction_payments` row that represents a card tender.
 * All lifecycle mutations go through `cardTerminal.*` — which are
 * thin wrappers over the `pos_card_*` RPCs — so the DB-level FSM
 * guard trigger runs on every transition and the C-3.4 outbox
 * trigger emits `payment.card.{captured,voided,reversed}` events.
 *
 * IMPORTANT: this component never writes to `pos_transaction_payments`
 * directly and never calls `supabase.rpc('pos_card_*')` directly —
 * the FSM is owned by `CardTerminalController`, and re-inlining the
 * RPCs here would bypass future driver/telemetry hooks. The arch
 * guard `pos-card-fsm.test.ts` enforces this.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CreditCard, CheckCircle2, XCircle, RotateCcw, Loader2 } from "lucide-react";
import { cardTerminal, type CardAuthState } from "@/services/pos/CardTerminalController";
import { ManagerOverrideDialog } from "@/components/pos/ManagerOverrideDialog";
import { useManagerOverride } from "@/hooks/pos/useManagerOverride";
import { useCurrency } from "@/hooks/useCurrency";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface CardPaymentActionsPayment {
  id: string;
  amount: number;
  authorized_amount?: number | null;
  auth_state?: string | null;
  capture_mode_used?: string | null;
  card_last_four?: string | null;
  card_type?: string | null;
  payment_method?: string | null;
  tender_kind?: string | null;
}

interface CardPaymentActionsProps {
  payment: CardPaymentActionsPayment;
  /** Register the payment belongs to — used for manager-override telemetry. */
  registerId?: string | null;
  /** Called after any successful transition so the parent can refetch. */
  onChanged?: (nextState: CardAuthState) => void;
  className?: string;
}

type PendingAction = "capture" | "void" | "reverse" | null;

// State → allowed transitions. Mirrors the DB `pos_card_fsm_transitions`
// guard; kept in sync with `CardTerminalController`. Values here only
// drive button visibility — the DB is still the source of truth.
const CAN_CAPTURE = (s?: string | null) => s === "approved";
const CAN_VOID    = (s?: string | null) => s === "approved" || s === "authorizing";
const CAN_REVERSE = (s?: string | null) => s === "captured";

const STATE_TONE: Record<string, string> = {
  approved:   "bg-blue-500/10 text-blue-600 border-blue-500/30",
  captured:   "bg-green-500/10 text-green-600 border-green-500/30",
  voided:     "bg-muted text-muted-foreground",
  refunded:   "bg-orange-500/10 text-orange-600 border-orange-500/30",
  declined:   "bg-red-500/10 text-red-600 border-red-500/30",
  failed:     "bg-red-500/10 text-red-600 border-red-500/30",
};

export function CardPaymentActions({
  payment,
  registerId,
  onChanged,
  className,
}: CardPaymentActionsProps) {
  const { formatCurrency } = useCurrency();
  const { requestOverride, isVerifying } = useManagerOverride();

  const [busy, setBusy] = useState<PendingAction>(null);
  const [overrideFor, setOverrideFor] = useState<PendingAction>(null);
  const [localState, setLocalState] = useState<CardAuthState>(
    (payment.auth_state as CardAuthState) ?? "idle",
  );

  // Only render for card tenders. Non-card rows (cash/mpesa/etc.) have
  // their own reversal flows.
  const isCard =
    payment.tender_kind === "card" ||
    payment.payment_method === "card" ||
    !!payment.auth_state;
  if (!isCard) return null;

  const captureVisible = CAN_CAPTURE(localState) &&
    // For auth_capture (single-message) rows, DB already recorded
    // `captured` at commit — no manual capture step exists.
    payment.capture_mode_used !== "auth_capture";

  const runCapture = async () => {
    setBusy("capture");
    try {
      const amount = payment.authorized_amount ?? payment.amount;
      const next = await cardTerminal.capture(payment.id, amount);
      setLocalState(next);
      onChanged?.(next);
      toast.success(`Captured ${formatCurrency(amount)}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Capture failed");
    } finally {
      setBusy(null);
    }
  };

  const runVoidOrReverse = async (kind: "void" | "reverse", overrideId?: string) => {
    setBusy(kind);
    try {
      const next = kind === "void"
        ? await cardTerminal.void(payment.id, overrideId ? `override:${overrideId}` : undefined)
        : await cardTerminal.reverse(payment.id, overrideId ? `override:${overrideId}` : undefined);
      setLocalState(next);
      onChanged?.(next);
      toast.success(kind === "void" ? "Authorization voided" : "Capture reversed");
    } catch (e: any) {
      toast.error(e?.message ?? `${kind} failed`);
    } finally {
      setBusy(null);
    }
  };

  const requestPinFor = (kind: "void" | "reverse") => setOverrideFor(kind);

  const handleOverrideApprove = async (pin: string, reason?: string) => {
    const kind = overrideFor;
    if (!kind || kind === "capture") return;
    const result = await requestOverride({
      action: kind === "void" ? "void_transaction" : "refund",
      pin,
      registerId: registerId ?? undefined,
      originalValue: payment.authorized_amount ?? payment.amount,
      reason,
    });
    setOverrideFor(null);
    await runVoidOrReverse(kind, result.overrideId);
  };

  const stateTone = STATE_TONE[localState] ?? "bg-muted text-muted-foreground";

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2 text-sm">
        <CreditCard className="h-4 w-4 text-muted-foreground" />
        <span className="capitalize">{payment.card_type ?? "card"}</span>
        {payment.card_last_four && (
          <span className="text-muted-foreground">••{payment.card_last_four}</span>
        )}
        <Badge variant="outline" className={cn("ml-auto text-xs", stateTone)}>
          {localState}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        {captureVisible && (
          <Button
            size="sm"
            variant="default"
            disabled={busy !== null}
            onClick={runCapture}
          >
            {busy === "capture"
              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              : <CheckCircle2 className="h-4 w-4 mr-1" />}
            Capture
          </Button>
        )}
        {CAN_VOID(localState) && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => requestPinFor("void")}
          >
            {busy === "void"
              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              : <XCircle className="h-4 w-4 mr-1" />}
            Void
          </Button>
        )}
        {CAN_REVERSE(localState) && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => requestPinFor("reverse")}
          >
            {busy === "reverse"
              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              : <RotateCcw className="h-4 w-4 mr-1" />}
            Reverse
          </Button>
        )}
      </div>

      <ManagerOverrideDialog
        open={overrideFor !== null}
        onOpenChange={(o) => !o && setOverrideFor(null)}
        action={overrideFor === "void" ? "void_transaction" : "refund"}
        originalValue={payment.authorized_amount ?? payment.amount}
        onApprove={handleOverrideApprove}
        isVerifying={isVerifying}
      />
    </div>
  );
}
