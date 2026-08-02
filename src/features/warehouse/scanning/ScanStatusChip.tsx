/**
 * ScanStatusChip — device/scan presence feedback for WMS execution surfaces
 * (Receiving audit finding #9).
 *
 * Operators must be able to answer "is the scanner actually pointed at this
 * screen?" without scanning something to find out. The chip reports:
 *
 *  - which scan target currently owns the stream (`scanRouter` top-of-stack),
 *  - whether the surface's own intent is the owner ("Listening" vs "Blocked"),
 *  - the last scan verdict seen on `scanFeedbackBus` (ok / error + code).
 *
 * Presentation only — it never registers a target and never resolves codes.
 */
import { useEffect, useState } from "react";
import { ScanLine, ShieldAlert, CheckCircle2, XCircle } from "lucide-react";
import { scanRouter } from "@/services/pos/scanRouter";
import { scanFeedbackBus, type ScanFeedback } from "@/services/pos/scanFeedbackBus";
import { StatusBadge } from "@/design-system";
import { cn } from "@/lib/utils";

interface Props {
  /** Label of the scan target this surface registered (e.g. `receiving-workspace.item`). */
  expectedLabel: string;
  /** Human wording for what the operator should scan next. */
  hint?: string;
  className?: string;
}

const POLL_MS = 1000;

export function ScanStatusChip({ expectedLabel, hint, className }: Props) {
  const [ownerLabel, setOwnerLabel] = useState<string | null>(null);
  const [last, setLast] = useState<{ f: ScanFeedback; at: number } | null>(null);

  // scanRouter has no change notification; a 1 s poll is cheap and keeps the
  // chip honest without coupling the router to React.
  useEffect(() => {
    const read = () => {
      const targets = scanRouter.getActiveTargets();
      setOwnerLabel(targets.length > 0 ? (targets[0].label ?? targets[0].id) : null);
    };
    read();
    const t = window.setInterval(read, POLL_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => scanFeedbackBus.on((f) => setLast({ f, at: Date.now() })), []);

  const owned = ownerLabel === expectedLabel;
  const tone = ownerLabel === null ? "neutral" : owned ? "success" : "warning";
  const stateText =
    ownerLabel === null ? "No scanner target" : owned ? "Listening" : `Held by ${ownerLabel}`;

  const lastOk = last?.f.kind === "ok" || last?.f.kind === "weighted";

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs", className)}>
      <StatusBadge tone={tone}>
        {owned ? <ScanLine className="mr-1 inline h-3 w-3" /> : <ShieldAlert className="mr-1 inline h-3 w-3" />}
        {stateText}
      </StatusBadge>
      {hint && owned && <span className="text-muted-foreground">{hint}</span>}
      {last && (
        <span className={cn("inline-flex items-center gap-1", lastOk ? "text-muted-foreground" : "text-destructive")}>
          {lastOk ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          <span className="font-mono">{last.f.raw.slice(0, 24) || "—"}</span>
          {last.f.detail && <span className="truncate max-w-[18rem]">{last.f.detail}</span>}
        </span>
      )}
    </div>
  );
}

export default ScanStatusChip;
