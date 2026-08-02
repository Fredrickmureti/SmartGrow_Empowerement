/**
 * ReceivingExceptionStrip — Receiving audit, Phase 5c.
 *
 * A discrepant trailer cannot be posted until someone decides what the
 * discrepancy *means*. That decision belongs at the dock, next to the pallet,
 * not in a warehouse-wide inbox two clicks away. The strip lists every open
 * exception raised against this session's lines and offers the two moves a
 * supervisor actually makes: acknowledge (I've seen it, keep receiving) and
 * resolve with a categorised cause (the RPC refuses a terminal state without
 * one).
 */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/design-system";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import {
  useReceivingExceptions,
  useResolveReceivingException,
  RECEIVING_OPEN_EXCEPTION_STATES,
  type ReceivingException,
  type ReceivingResolutionKind,
} from "./useReceivingExceptions";

/** Mirrors `wms_exception_resolution_kind`, narrowed to receiving causes. */
const RECEIVING_CAUSES: { value: ReceivingResolutionKind; label: string }[] = [
  { value: "short_scan", label: "Short scan" },
  { value: "damaged", label: "Damaged stock" },
  { value: "wrong_lp", label: "Wrong licence plate" },
  { value: "miscount", label: "Miscount" },
  { value: "process_error", label: "Process error" },
  { value: "other", label: "Other" },
];

const severityTone = (n: number) =>
  n >= 4 ? "danger" : n === 3 ? "warning" : n === 2 ? "info" : "neutral";

function ExceptionRow({ ex }: { ex: ReceivingException }) {
  const resolve = useResolveReceivingException();
  const [cause, setCause] = useState<ReceivingResolutionKind | "">("");
  const [note, setNote] = useState("");

  const run = (to: "acknowledged" | "resolved") =>
    resolve.mutate(
      {
        id: ex.id,
        to,
        rowVersion: ex.row_version,
        resolution: to === "resolved" ? note : null,
        resolutionKind: to === "resolved" ? (cause || null) : null,
      },
      {
        onSuccess: () => toast.success(to === "resolved" ? "Exception resolved" : "Exception acknowledged"),
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : "Could not update the exception"),
      },
    );

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2">
      <StatusBadge tone={severityTone(ex.severity)}>{ex.kind.replace(/_/g, " ")}</StatusBadge>
      <span className="flex-1 min-w-[12rem] text-xs">{ex.reason ?? "—"}</span>
      <StatusBadge tone={ex.state === "escalated" ? "danger" : "neutral"}>{ex.state}</StatusBadge>
      <Select value={cause} onValueChange={(v) => setCause(v as ReceivingResolutionKind)}>
        <SelectTrigger className="h-8 w-40"><SelectValue placeholder="Cause" /></SelectTrigger>
        <SelectContent>
          {RECEIVING_CAUSES.map((c) => (
            <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        className="h-8 w-44"
        placeholder="What happened?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {ex.state === "open" && (
        <Button size="sm" variant="ghost" disabled={resolve.isPending} onClick={() => run("acknowledged")}>
          Acknowledge
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={resolve.isPending || !cause}
        title={cause ? undefined : "Pick a cause — the ledger records why, not just that"}
        onClick={() => run("resolved")}
      >
        <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Resolve
      </Button>
    </div>
  );
}

export function ReceivingExceptionStrip({ sessionId }: { sessionId: string }) {
  const { data: exceptions } = useReceivingExceptions(sessionId);
  const open = (exceptions ?? []).filter((e) =>
    (RECEIVING_OPEN_EXCEPTION_STATES as string[]).includes(e.state),
  );
  if (open.length === 0) return null;

  return (
    <div className="mt-4 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <ShieldAlert className="h-4 w-4 text-destructive" />
        {open.length} open exception{open.length === 1 ? "" : "s"} on this trailer
      </div>
      <p className="text-xs text-muted-foreground">
        Posting stays available — resolving here records the cause against the line, so the
        variance is explained in the ledger rather than absorbed silently.
      </p>
      {open.map((ex) => <ExceptionRow key={ex.id} ex={ex} />)}
    </div>
  );
}

export default ReceivingExceptionStrip;
