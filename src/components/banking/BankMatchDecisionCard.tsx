/**
 * BankMatchDecisionCard — one reconciliation decision, explained.
 *
 * Read-only by construction: it states what was matched, on what evidence, by
 * which rule (or by hand), by whom, when, and — when reversed — that it was
 * corrected. There are deliberately no action buttons here; deciding happens on
 * the match sheet through the canonical seams.
 */
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { format } from "date-fns";
import { CircleDot, CheckCircle2, XCircle, Undo2 } from "lucide-react";
import {
  describeMatchEvent,
  type BankMatchDecision,
  type BankMatchHistoryEvent,
} from "@/hooks/useBankMatchHistory";

const EVENT_ICON: Record<BankMatchHistoryEvent["event"], typeof CircleDot> = {
  proposed: CircleDot,
  confirmed: CheckCircle2,
  rejected: XCircle,
  reversed: Undo2,
};

function formatStamp(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : format(parsed, "MMM d, yyyy h:mm a");
}

function evidenceLines(evidence: Record<string, unknown>): string[] {
  const raw = (evidence?.reasons ?? evidence?.evidence) as unknown;
  if (Array.isArray(raw)) return raw.map((r) => String(r));
  return Object.entries(evidence ?? {})
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`);
}

interface Props {
  decision: BankMatchDecision;
  formatAmount: (value: number) => string;
}

export function BankMatchDecisionCard({ decision, formatAmount }: Props) {
  const reasons = evidenceLines(decision.evidence ?? {});

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={decision.is_reversed ? "outline" : "secondary"} className="capitalize">
          {decision.status}
        </Badge>
        <Badge variant="outline">
          {decision.origin === "rule"
            ? `Rule: ${decision.rule_name ?? "unnamed rule"}`
            : "Matched by hand"}
        </Badge>
        {decision.match_type && (
          <Badge variant="outline" className="capitalize">
            {decision.match_type.replace(/_/g, " ")}
          </Badge>
        )}
        {decision.is_reversed && (
          <span className="text-xs text-muted-foreground">
            This decision was later corrected — it no longer explains the line.
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div>
          <p className="text-muted-foreground">Matched</p>
          <p className="font-medium tabular-nums">{formatAmount(Number(decision.matched_amount) || 0)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Residual</p>
          <p className="font-medium tabular-nums">{formatAmount(Number(decision.residual_amount) || 0)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Bank fee</p>
          <p className="font-medium tabular-nums">{formatAmount(Number(decision.fee_amount) || 0)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Exchange rate</p>
          <p className="font-medium tabular-nums">{decision.exchange_rate ?? "—"}</p>
        </div>
      </div>

      {decision.allocations.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Applied to</p>
          {decision.allocations.map((allocation, index) => (
            <div
              key={`${allocation.document_id ?? "alloc"}-${index}`}
              className="flex items-center justify-between text-xs"
            >
              <span className="truncate">
                <span className="capitalize">{(allocation.document_type ?? "document").replace(/_/g, " ")}</span>
                {allocation.description ? ` — ${allocation.description}` : ""}
              </span>
              <span className="tabular-nums font-medium">{formatAmount(Number(allocation.amount) || 0)}</span>
            </div>
          ))}
        </div>
      )}

      {reasons.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {reasons.slice(0, 6).map((reason) => (
            <Badge key={reason} variant="outline" className="text-[10px] font-normal">
              {reason}
            </Badge>
          ))}
        </div>
      )}

      <Separator />

      <ol className="space-y-2">
        {decision.events.map((event, index) => {
          const Icon = EVENT_ICON[event.event] ?? CircleDot;
          return (
            <li key={`${event.event}-${index}`} className="flex items-start gap-2 text-xs">
              <Icon
                className={
                  event.event === "reversed" || event.event === "rejected"
                    ? "mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                    : "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                }
              />
              <div>
                <p className="font-medium">{describeMatchEvent(event)}</p>
                <p className="text-muted-foreground">
                  {formatStamp(event.at)}
                  {event.detail ? ` • ${event.detail}` : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {(decision.journal_entry_id ||
        decision.fee_journal_entry_id ||
        decision.adjustment_journal_entry_id) && (
        <p className="text-[10px] text-muted-foreground">
          Journal entries:{" "}
          {[
            decision.journal_entry_id && `settlement ${decision.journal_entry_id.slice(0, 8)}`,
            decision.fee_journal_entry_id && `fee ${decision.fee_journal_entry_id.slice(0, 8)}`,
            decision.adjustment_journal_entry_id &&
              `adjustment ${decision.adjustment_journal_entry_id.slice(0, 8)}`,
          ]
            .filter(Boolean)
            .join(" • ")}
        </p>
      )}
    </div>
  );
}
