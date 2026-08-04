/**
 * PutawaySuggestionChips — shows WHY the engine picked a bin.
 *
 * A putaway destination without provenance is an unexplainable instruction.
 * These chips surface the winning strategy, the runners-up and how much of
 * the quantity each bin can actually take.
 */
import { StatusBadge } from "@/design-system";
import { usePutawaySuggestions } from "./usePutawayData";

export function PutawaySuggestionChips({ taskId }: { taskId: string }) {
  const { data } = usePutawaySuggestions(taskId);
  const rows = data ?? [];
  if (rows.length === 0) return null;
  const chosen = rows.find((r) => r.chosen) ?? rows[0];
  const alternatives = rows.filter((r) => r.id !== chosen.id).slice(0, 3);

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <StatusBadge tone="info">
        {(chosen.strategy ?? "suggested").replace(/_/g, " ")}
      </StatusBadge>
      {chosen.feasible_qty != null && (
        <span className="text-muted-foreground">fits {Number(chosen.feasible_qty)}</span>
      )}
      {alternatives.length > 0 && (
        <span className="text-muted-foreground">
          · alt {alternatives.map((a) => a.location?.code ?? "—").join(", ")}
        </span>
      )}
    </div>
  );
}

export default PutawaySuggestionChips;