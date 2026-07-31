/**
 * CancelAggregateButton — the single UI entry point for cancelling a WMS
 * aggregate (pick wave, loading manifest, QC inspection, count session).
 *
 * Cancellation is a real business event, not a delete: the server FSM
 * (`wms_transition_*`) validates the edge, enforces the optimistic
 * `row_version` lock so two supervisors cannot cancel over each other,
 * unwinds dependent work (tasks, carton links, reservations), and emits
 * `warehouse.<aggregate>.cancelled` onto the outbox. This component keeps
 * every screen on that one path — no page may write `state` itself.
 *
 * A reason is mandatory: cancelled work is audited and, for 3PL billing,
 * the reason decides whether the labour is still chargeable.
 */
import { useState } from "react";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useWaveTransition,
  useManifestTransition,
  useQcTransition,
  useCountSessionTransition,
} from "./useAggregateTransitions";

export type CancellableAggregate = "wave" | "manifest" | "qc" | "count";

/** States from which the server FSM accepts a `cancelled` edge. */
const CANCELLABLE_FROM: Record<CancellableAggregate, readonly string[]> = {
  wave: ["draft", "released", "picking", "picked", "packing"],
  manifest: ["draft", "loading", "closed"],
  qc: ["pending", "in_progress"],
  count: ["draft", "counting", "review"],
};

const LABEL: Record<CancellableAggregate, string> = {
  wave: "wave",
  manifest: "manifest",
  qc: "inspection",
  count: "count session",
};

const CONSEQUENCE: Record<CancellableAggregate, string> = {
  wave: "Outstanding pick tasks are cancelled and reserved stock is released back to available.",
  manifest:
    "Loaded cartons are unlinked from this manifest and their load tasks return to the queue.",
  qc: "The inspection is closed without a verdict; held stock stays in its current status.",
  count: "Recorded counts are discarded — no inventory adjustment is posted.",
};

export function canCancel(aggregate: CancellableAggregate, state: string): boolean {
  return CANCELLABLE_FROM[aggregate].includes(state);
}

interface Props {
  aggregate: CancellableAggregate;
  id: string;
  /** Current `row_version` — the optimistic lock the server checks. */
  rowVersion: number;
  /** Current state; the button hides itself when cancellation is illegal. */
  state: string;
  size?: "sm" | "default";
  variant?: "ghost" | "outline" | "destructive";
  onCancelled?: () => void;
}

export function CancelAggregateButton({
  aggregate,
  id,
  rowVersion,
  state,
  size = "sm",
  variant = "ghost",
  onCancelled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  // Hooks are unconditional; only the dispatch is aggregate-specific.
  const wave = useWaveTransition();
  const manifest = useManifestTransition();
  const qc = useQcTransition();
  const count = useCountSessionTransition();
  const mutation = { wave, manifest, qc, count }[aggregate];

  if (!canCancel(aggregate, state)) return null;

  const submit = () => {
    mutation.mutate(
      { id, toState: "cancelled" as never, rowVersion, reason: reason.trim() },
      {
        onSuccess: () => {
          setReason("");
          setOpen(false);
          onCancelled?.();
        },
      },
    );
  };

  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <Ban className="h-3.5 w-3.5 mr-1" /> Cancel
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel {LABEL[aggregate]}</DialogTitle>
            <DialogDescription>{CONSEQUENCE[aggregate]}</DialogDescription>
          </DialogHeader>
          <div>
            <Label>Reason</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Order pulled, customer cancelled, duplicate…"
              autoFocus
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Recorded on the cancellation event for audit and billing.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={mutation.isPending || reason.trim().length < 3}
              onClick={submit}
            >
              {mutation.isPending ? "Cancelling…" : `Cancel ${LABEL[aggregate]}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default CancelAggregateButton;
