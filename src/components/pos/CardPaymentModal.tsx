/**
 * Wave 2 · Phase C-2 — Card / EMV terminal modal.
 *
 * Drives the CardTerminalController's `driver.authorize()` pre-commit so
 * the cashier can see the terminal FSM in real time: Insert card →
 * Authorizing → Approved / Declined. The resulting auth metadata
 * (authId, vendorTxnId, authorized amount, card last-four / brand,
 * capture_mode) is handed back to `PaymentDialog`, which stashes it on
 * the `PaymentDialogPayment` line. When the sale commits,
 * `process_pos_transaction → _pos_record_payment` inserts the payment
 * row with `auth_state='approved'` (or `captured` for auth_capture) and
 * the FSM guard trigger validates the initial state.
 *
 * IMPORTANT: this modal never writes to `pos_transaction_payments` on
 * its own. All mutation is via the `pos_card_*` RPCs at commit-time
 * (initial insert) and via `CardTerminalController.capture/void/reverse`
 * for post-commit lifecycle (settlement, refunds).
 */
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CreditCard, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { cardTerminal, type CardAuthState } from "@/services/pos/CardTerminalController";
import { toast } from "sonner";

export interface CardAuthPayload {
  authId: string;
  vendorTxnId: string;
  authorizedAmount: number;
  cardLastFour?: string;
  cardType?: string;
  /** 'auth_only' → post-commit capture; 'auth_capture' → captured at commit. */
  captureMode: "auth_only" | "auth_capture";
  /** Initial FSM state to persist on the payment row insert. */
  initialAuthState: Extract<CardAuthState, "approved" | "captured">;
}

interface CardPaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  amount: number;
  /** From the payment method catalog. Drives whether we auto-capture. */
  captureMode: "auth_only" | "auth_capture";
  onSuccess: (payload: CardAuthPayload) => void;
  onCancel?: () => void;
}

type UiState =
  | { kind: "prompt" }
  | { kind: "authorizing" }
  | { kind: "approved"; auth: CardAuthPayload }
  | { kind: "declined"; message: string };

export function CardPaymentModal({
  open,
  onOpenChange,
  amount,
  captureMode,
  onSuccess,
  onCancel,
}: CardPaymentModalProps) {
  const { formatCurrency } = useCurrency();
  const [state, setState] = useState<UiState>({ kind: "prompt" });
  // Reset when reopened.
  const openRef = useRef(open);
  useEffect(() => {
    if (open && !openRef.current) setState({ kind: "prompt" });
    openRef.current = open;
  }, [open]);

  const runAuthorize = async () => {
    setState({ kind: "authorizing" });
    try {
      // Driver-only pre-auth: no DB row exists yet. The DB row is inserted
      // by `_pos_record_payment` at commit with `auth_state='approved'`
      // (or 'captured') and the auth metadata below.
      const vendor = await cardTerminal["driver"].authorize({
        amount,
        // No paymentId yet — pass a synthetic session ref for the driver's
        // internal correlation. Real EMV SDKs use their own session UUID.
        paymentId: `pre_${crypto.randomUUID()}`,
      });
      const payload: CardAuthPayload = {
        authId: vendor.authId,
        vendorTxnId: vendor.vendorTxnId,
        authorizedAmount: vendor.authorizedAmount,
        cardLastFour: vendor.cardLastFour,
        cardType: vendor.cardType,
        captureMode,
        initialAuthState: captureMode === "auth_capture" ? "captured" : "approved",
      };
      setState({ kind: "approved", auth: payload });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Terminal declined";
      setState({ kind: "declined", message });
    }
  };

  const handleConfirm = () => {
    if (state.kind !== "approved") return;
    onSuccess(state.auth);
    onOpenChange(false);
  };

  const handleCancel = () => {
    if (state.kind === "authorizing") {
      // Physical terminals can't be aborted mid-flight in the sim — but a
      // real driver would call `driver.cancel()`. For now, warn and no-op.
      toast.warning("Wait for the terminal to finish before cancelling.");
      return;
    }
    onCancel?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleCancel(); else onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Card Payment · {formatCurrency(amount)}
          </DialogTitle>
        </DialogHeader>

        <div className="py-6 space-y-4">
          {state.kind === "prompt" && (
            <>
              <div className="text-center space-y-2">
                <CreditCard className="mx-auto h-12 w-12 text-muted-foreground" />
                <p className="font-medium">Ready to charge card</p>
                <p className="text-sm text-muted-foreground">
                  {captureMode === "auth_capture"
                    ? "Amount will be authorized and captured together."
                    : "Amount will be authorized now; capture on settlement."}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button className="flex-1" onClick={runAuthorize}>
                  Start Terminal
                </Button>
              </div>
            </>
          )}

          {state.kind === "authorizing" && (
            <div className="text-center space-y-3 py-4">
              <Loader2 className="mx-auto h-12 w-12 animate-spin text-primary" />
              <p className="font-medium">Insert / tap card…</p>
              <p className="text-sm text-muted-foreground">Waiting for terminal.</p>
            </div>
          )}

          {state.kind === "approved" && (
            <>
              <div className="text-center space-y-2">
                <CheckCircle2 className="mx-auto h-12 w-12 text-green-600" />
                <p className="font-medium">Approved</p>
                <p className="text-sm text-muted-foreground">
                  {state.auth.cardType?.toUpperCase() ?? "CARD"} ••••{state.auth.cardLastFour ?? "----"}
                </p>
                <p className="text-xs text-muted-foreground font-mono">
                  Auth {state.auth.authId.slice(0, 12)}…
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={handleCancel}>
                  Cancel & Void
                </Button>
                <Button className="flex-1" onClick={handleConfirm}>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Attach to Sale
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground text-center">
                Voiding here discards the pre-auth (no DB row was created).
              </p>
            </>
          )}

          {state.kind === "declined" && (
            <>
              <div className="text-center space-y-2">
                <XCircle className="mx-auto h-12 w-12 text-destructive" />
                <p className="font-medium">Declined</p>
                <p className="text-sm text-muted-foreground flex items-center justify-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {state.message}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button className="flex-1" onClick={runAuthorize}>
                  Retry
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
