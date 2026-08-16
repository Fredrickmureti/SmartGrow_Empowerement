/**
 * PaymentResumeBanner — POS Wave · Phase 9 (offline / retry behaviour)
 *
 * A payment session is a durable, server-owned aggregate: money can be
 * tendered into it before the sale commits. If the cashier's browser reloads,
 * the terminal crashes, or a card/M-Pesa authorisation times out, that session
 * stays `open` on the register holding real tendered money — invisible to the
 * next cashier, and a hard blocker at till close (`pos_till_close_blockers`).
 *
 * This banner surfaces those sessions from the canonical read seam
 * `pos_register_open_payment_sessions` (SECURITY DEFINER, branch-access
 * checked) and offers the two safe operator actions:
 *
 *   • Open tender — navigate back to the tender surface for this register.
 *   • Discard — `pos_payment_session_cancel`, which the server refuses when
 *     captured non-cash money is attached (it will surface that error).
 *
 * No money math happens here: allocated / remaining come from the server.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useCurrency } from "@/hooks/useCurrency";
import {
  listOpenSessions,
  cancelSession,
  type OpenPaymentSession,
} from "@/lib/pos/paymentSessionClient";

interface PaymentResumeBannerProps {
  registerId: string | null;
  /** Poll interval; 0 disables polling (used by tests). */
  refreshMs?: number;
}

export function PaymentResumeBanner({ registerId, refreshMs = 30_000 }: PaymentResumeBannerProps) {
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const [sessions, setSessions] = useState<OpenPaymentSession[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!registerId) {
      setSessions([]);
      return;
    }
    try {
      const rows = await listOpenSessions(registerId);
      // Only sessions that actually hold money (or have tenders attached) are
      // operator-actionable. Zero-tender sessions are swept server-side.
      setSessions(rows.filter((r) => r.allocated > 0 || r.tender_count > 0));
    } catch {
      // A read failure must never break the sale surface.
      setSessions([]);
    }
  }, [registerId]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void load();
    };
    run();
    if (!refreshMs) return () => { cancelled = true; };
    const t = setInterval(run, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [load, refreshMs]);

  const handleDiscard = useCallback(
    async (session: OpenPaymentSession) => {
      setBusyId(session.session_id);
      try {
        await cancelSession({
          sessionId: session.session_id,
          reason: "operator discarded an abandoned payment from the resume banner",
        });
        toast.success("Payment discarded");
        await load();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not discard this payment — captured money may still be attached",
        );
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  if (!registerId || sessions.length === 0) return null;

  return (
    <div className="border-b bg-amber-500/10 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4" />
        Payment in progress on this register
      </div>
      {sessions.map((s) => (
        <div
          key={s.session_id}
          className="rounded-md border bg-card p-2 text-xs space-y-1.5"
        >
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tendered</span>
            <span className="font-medium">{formatCurrency(s.allocated)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Remaining</span>
            <span className="font-medium">{formatCurrency(s.remaining)}</span>
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant="secondary"
              className="flex-1"
              onClick={() => navigate(`/pos/terminal/${registerId}/tender`)}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Open tender
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busyId === s.session_id}
              onClick={() => handleDiscard(s)}
            >
              {busyId === s.session_id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default PaymentResumeBanner;
