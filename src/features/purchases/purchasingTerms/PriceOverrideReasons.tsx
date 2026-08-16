/**
 * Purchase price override justification (ADR 0142, Phase 9).
 *
 * The resolved price comes from the server (`_resolve_purchase_line_price`,
 * stamped onto `purchase_order_items.resolved_unit_price`). This panel never
 * ranks price sources and never computes a tolerance — it only lets the
 * operator record *why* a line is priced away from the resolved condition.
 * The database decides whether a reason or an approval is required.
 */
import { AlertTriangle } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface OverridableLine {
  description?: string;
  unit_price: number;
  resolved_unit_price?: number | null;
  price_override_reason?: string | null;
}

interface Props<T extends OverridableLine> {
  lines: T[];
  formatCurrency: (value: number) => string;
  onPatch: (index: number, patch: { price_override_reason: string }) => void;
}

export function PriceOverrideReasons<T extends OverridableLine>({
  lines,
  formatCurrency,
  onPatch,
}: Props<T>) {
  const deviating = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        line.resolved_unit_price != null &&
        Number(line.unit_price) !== Number(line.resolved_unit_price),
    );

  if (deviating.length === 0) return null;

  return (
    <div className="space-y-3 rounded-md border border-warning/40 bg-muted/40 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="h-4 w-4 text-warning" />
        Prices differing from the supplier condition
      </div>
      <p className="text-xs text-muted-foreground">
        Your organisation may require a justification — and an approval — before an
        order can be priced away from the resolved supplier condition.
      </p>
      {deviating.map(({ line, index }) => (
        <div key={index} className="space-y-1.5">
          <Label className="text-xs">
            {line.description || `Line ${index + 1}`} — resolved{" "}
            {formatCurrency(Number(line.resolved_unit_price ?? 0))}, agreed{" "}
            {formatCurrency(Number(line.unit_price ?? 0))}
          </Label>
          <Textarea
            rows={2}
            value={line.price_override_reason ?? ""}
            placeholder="Why is this line priced differently?"
            onChange={(e) => onPatch(index, { price_override_reason: e.target.value })}
          />
        </div>
      ))}
    </div>
  );
}
