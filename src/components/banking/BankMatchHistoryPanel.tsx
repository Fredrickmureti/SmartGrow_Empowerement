/**
 * BankMatchHistoryPanel — why this bank line reads the way it does.
 *
 * Reads only through `bank_match_history` (see `useBankMatchHistory`), which
 * enforces business and branch scope in the database. No actions live here.
 */
import { Loader2, History } from "lucide-react";
import { format } from "date-fns";
import { useBankMatchHistory } from "@/hooks/useBankMatchHistory";
import { BankMatchDecisionCard } from "@/components/banking/BankMatchDecisionCard";

interface Props {
  bankTransactionId?: string;
  formatAmount: (value: number) => string;
  enabled?: boolean;
}

export function BankMatchHistoryPanel({ bankTransactionId, formatAmount, enabled = true }: Props) {
  const { data, isLoading, error } = useBankMatchHistory(bankTransactionId, enabled);

  if (!bankTransactionId) return null;

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        This line's history could not be read: {error instanceof Error ? error.message : "unknown error"}
      </p>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-muted/40 p-3">
        <p className="text-sm font-medium">{data.description || "Bank line"}</p>
        <p className="text-xs text-muted-foreground">
          {format(new Date(data.transaction_date), "MMM d, yyyy")} •{" "}
          {formatAmount(Math.abs(Number(data.amount) || 0))}
          {data.reference ? ` • Ref ${data.reference}` : ""}
          {data.match_source ? ` • Explained by ${data.match_source.replace(/_/g, " ")}` : ""}
        </p>
      </div>

      {data.decisions.length === 0 ? (
        <div className="py-8 text-center">
          <History className="mx-auto mb-3 h-8 w-8 text-muted-foreground opacity-50" />
          <p className="text-sm font-medium text-muted-foreground">No decision has been taken on this line</p>
          <p className="text-xs text-muted-foreground">
            Nothing has been proposed, confirmed or reversed against it yet.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.decisions.map((decision) => (
            <BankMatchDecisionCard
              key={decision.match_id}
              decision={decision}
              formatAmount={formatAmount}
            />
          ))}
        </div>
      )}
    </div>
  );
}
