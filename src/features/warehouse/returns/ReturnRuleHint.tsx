/**
 * ReturnRuleHint — shows the disposition rule that will most likely fire for a
 * line, so "Apply disposition rule" is never a black box.
 *
 * Matching here MIRRORS `wms_disposition_return_line` (most specific rule
 * first, then priority) for explanation only — the server remains the
 * authority and may pick differently if rules changed mid-session.
 */
import { useMemo } from "react";
import { Info } from "lucide-react";
import { useReturnDispositionRules } from "./useReturnDispositionRules";
import type { ReturnDispositionRule, ReturnLine, ReturnOrder } from "./returnsModel";

function specificity(r: ReturnDispositionRule): number {
  return (
    (r.product_id ? 8 : 0) +
    (r.condition_code ? 4 : 0) +
    (r.customer_id ? 2 : 0) +
    (r.return_kind ? 1 : 0)
  );
}

export function matchReturnRule(
  rules: ReturnDispositionRule[],
  order: ReturnOrder,
  line: ReturnLine,
): ReturnDispositionRule | null {
  const candidates = rules.filter(
    (r) =>
      r.is_active !== false &&
      (r.warehouse_id == null || r.warehouse_id === order.warehouse_id) &&
      (r.return_kind == null || r.return_kind === order.return_kind) &&
      (r.condition_code == null || r.condition_code === line.condition_code) &&
      (r.product_id == null || r.product_id === line.product_id) &&
      (r.customer_id == null || r.customer_id === order.customer_id),
  );
  candidates.sort(
    (a, b) => specificity(b) - specificity(a) || (a.priority ?? 100) - (b.priority ?? 100),
  );
  return candidates[0] ?? null;
}

export interface ReturnRuleHintProps {
  order: ReturnOrder;
  line: ReturnLine;
}

export function ReturnRuleHint({ order, line }: ReturnRuleHintProps) {
  const { data: rules, isLoading } = useReturnDispositionRules(order.business_id);
  const match = useMemo(
    () => (rules ? matchReturnRule(rules, order, line) : null),
    [rules, order, line],
  );

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Resolving disposition rules…</p>;
  }

  if (!match) {
    return (
      <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        No disposition rule matches this line — the server will fall back to its
        default routing. Use a manual override to be explicit.
      </p>
    );
  }

  return (
    <div className="rounded-md border bg-muted/40 p-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <Info className="h-3.5 w-3.5" /> {match.name}
      </div>
      <div className="mt-1 text-muted-foreground">
        Routes to <span className="font-medium">{match.disposition.replace(/_/g, " ")}</span>
        {match.requires_inspection ? " · inspection required" : " · no inspection required"}
        {" · priority "}
        {match.priority}
      </div>
    </div>
  );
}
