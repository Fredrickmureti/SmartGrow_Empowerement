/**
 * TaskBlockerChip — small chip rendered on Kanban/list/detail showing
 * whether a task is blocked by predecessors (depends_on).
 *
 *   • Red "Blocked by N" when one or more predecessors are still open
 *   • Muted "✓ N" when all predecessors are done
 *   • Nothing when there are no predecessors
 *
 * Pure presentational — accepts the predecessor task list rather than
 * issuing its own query so it can be embedded anywhere cheaply.
 */
import { Badge } from "@/components/ui/badge";
import { Lock, CheckCircle2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface BlockerPredecessor {
  id: string;
  name: string;
  is_done: boolean;
}

interface Props {
  predecessors: BlockerPredecessor[];
  size?: "sm" | "xs";
}

export function TaskBlockerChip({ predecessors, size = "sm" }: Props) {
  if (!predecessors || predecessors.length === 0) return null;
  const open = predecessors.filter((p) => !p.is_done);
  const all = predecessors.length;
  const done = all - open.length;
  const blocked = open.length > 0;

  const cls =
    size === "xs" ? "h-4 px-1 text-[10px] gap-0.5" : "h-5 px-1.5 text-xs gap-1";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={blocked ? "destructive" : "secondary"}
          className={cls}
          onClick={(e) => e.stopPropagation()}
        >
          {blocked ? (
            <>
              <Lock className={size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3"} />
              {open.length}/{all}
            </>
          ) : (
            <>
              <CheckCircle2 className={size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3"} />
              {done}
            </>
          )}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <div className="text-xs font-semibold mb-1">
          {blocked ? "Blocked by" : "Predecessors complete"}
        </div>
        <ul className="space-y-0.5">
          {predecessors.map((p) => (
            <li key={p.id} className="flex items-center gap-1 text-xs">
              {p.is_done ? (
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              ) : (
                <Lock className="h-3 w-3 text-destructive" />
              )}
              <span className={p.is_done ? "line-through opacity-70" : ""}>
                {p.name}
              </span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
