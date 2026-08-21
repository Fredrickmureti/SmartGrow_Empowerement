/**
 * BankSessionAuditTrail — the decision record of a whole reconciliation session.
 *
 * A closed session's proof is not only its balances: it is every line it
 * explained and on whose authority. This reads only through
 * `bank_match_session_history`, which asserts business and branch scope in the
 * database, and offers no actions.
 */
import { Loader2, ScrollText } from "lucide-react";
import { format } from "date-fns";
import { useBankSessionMatchHistory } from "@/hooks/useBankMatchHistory";
import { BankMatchDecisionCard } from "@/components/banking/BankMatchDecisionCard";

interface Props {
  sessionId?: string;
  formatAmount: (value: number) => string;
  enabled?: boolean;
}

export function BankSessionAuditTrail({ sessionId, formatAmount, enabled = true }: Props) {
  const { data, isLoading, error } = useBankSessionMatchHistory(sessionId, enabled);

  if (!sessionId) return null;

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="py-4 text-xs text-muted-foreground">
        This session's audit trail could not be read:{" "}
        {error instanceof Error ? error.message : "unknown error"}
      </p>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {data.completed_at
          ? `Closed ${format(new Date(data.completed_at), "MMM d, yyyy h:mm a")}${
              data.completed_by_name ? ` by ${data.completed_by_name}` : ""
            }`
          : "This session is not closed yet."}
        {data.cancelled_at &&
          ` • Cancelled ${format(new Date(data.cancelled_at), "MMM d, yyyy h:mm a")}${
            data.cancelled_by_name ? ` by ${data.cancelled_by_name}` : ""
          }${data.cancel_reason ? ` — ${data.cancel_reason}` : ""}`}
      </div>

      {data.entries.length === 0 ? (
        <div className="py-6 text-center">
          <ScrollText className="mx-auto mb-2 h-7 w-7 text-muted-foreground opacity-50" />
          <p className="text-xs text-muted-foreground">
            No match decision was recorded against the lines in this session.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.entries.map((entry, index) => (
            <div key={`${entry.decision.match_id}-${index}`} className="space-y-1">
              <p className="text-xs font-medium">
                {format(new Date(entry.transaction_date), "MMM d, yyyy")} — {entry.description || "Bank line"}{" "}
                <span className="tabular-nums text-muted-foreground">
                  {formatAmount(Math.abs(Number(entry.amount) || 0))}
                </span>
              </p>
              <BankMatchDecisionCard decision={entry.decision} formatAmount={formatAmount} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
