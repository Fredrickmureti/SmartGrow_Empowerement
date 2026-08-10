/**
 * BillMatchBadge / BillMatchPanel — the two ways match state is shown.
 *
 * Both read their words from `matchState.ts` so the list column and the
 * record page can never describe the same result differently.
 */
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Section } from "@/design-system";
import { useBillMatch } from "@/hooks/useBillMatch";
import {
  exceptionStateLabel,
  matchStateHelp,
  matchStateLabel,
  matchStateTone,
  matchToneClasses,
  needsMatchReview,
  type BillMatchResult,
} from "./matchState";

export function BillMatchBadge({ result }: { result: BillMatchResult | null | undefined }) {
  const tone = matchStateTone(result?.match_state);
  return (
    <Badge variant="outline" className={matchToneClasses(tone)}>
      {matchStateLabel(result?.match_state)}
      {needsMatchReview(result) ? " · review" : ""}
    </Badge>
  );
}

export function BillMatchPanel({
  billId,
  currency,
  formatCurrency,
  onResolved,
}: {
  billId: string;
  currency?: string | null;
  formatCurrency?: (v: number) => string;
  onResolved?: () => void;
}) {
  const { result, loading, resolving, resolveException } = useBillMatch(billId);
  const [note, setNote] = useState("");

  const money = (v: number) => (formatCurrency ? formatCurrency(v) : `${v.toFixed(2)} ${currency ?? ""}`);

  const decide = async (decision: "approved" | "rejected") => {
    const ok = await resolveException(decision, note.trim() || undefined);
    if (ok) {
      setNote("");
      onResolved?.();
    }
  };

  return (
    <Section title="Three-way match">
      {loading && !result ? (
        <p className="text-sm text-muted-foreground">Loading match state…</p>
      ) : !result ? (
        <p className="text-sm text-muted-foreground">
          Not matched yet. Matching runs automatically when the bill is submitted for approval,
          and can be re-run from the actions menu.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <BillMatchBadge result={result} />
            <span className="text-sm text-muted-foreground">
              {exceptionStateLabel(result.exception_state)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{matchStateHelp(result.match_state)}</p>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Quantity variance</dt>
              <dd className="tabular-nums">{result.qty_variance}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Price variance</dt>
              <dd className="tabular-nums">{money(result.price_variance)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Landed-cost uplift</dt>
              <dd className="tabular-nums">{(result.landed_cost_uplift * 100).toFixed(2)}%</dd>
            </div>
          </dl>
          {needsMatchReview(result) && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-sm font-medium">Review this variance</p>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why is this variance acceptable, or what has to be corrected?"
                rows={2}
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={resolving} onClick={() => void decide("approved")}>
                  Accept variance
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resolving}
                  onClick={() => void decide("rejected")}
                >
                  Reject
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
