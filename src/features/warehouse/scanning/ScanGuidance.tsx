/**
 * ScanGuidance — the one operator-facing scan surface (Phase 4.2 – 4.4).
 *
 * Supersedes `ScanStatusChip`, which reported router internals ("Listening",
 * "Held by …"). This surface answers the four questions an operator has,
 * in their language:
 *
 *   1. What should I scan now?      — derived from the mounted intent
 *   2. Which input is live?         — device mode + last event source
 *   3. Did the last scan work?      — accepted / duplicate / wrong kind / unknown
 *   4. What happens next?           — the "then" half of the prompt
 *
 * Plus the last few scans (Phase 4.4), so a mis-scan is visible without
 * scanning again to find out.
 *
 * Presentation only: it never registers a target and never resolves a code.
 */
import { useEffect, useState } from "react";
import { ScanLine, ShieldAlert, CheckCircle2, XCircle, Copy, HelpCircle } from "lucide-react";
import { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";
import type { ScanEvent } from "@/services/pos/scanBus";
import { scanBus } from "@/services/pos/scanBus";
import { cn } from "@/lib/utils";
import { useLocalScan } from "@/hooks/scanner/useLocalScan";
import { ScanCameraButton } from "@/components/scanner/ScanCameraButton";
import { useActiveScanTarget } from "./useActiveScanTarget";
import { useScanHistory, type ScanHistoryEntry } from "./useScanHistory";
import {
  intentFromTargetLabel,
  promptForIntent,
  describeScanSource,
  classifyFeedback,
  verdictCopy,
  type ScanVerdict,
} from "./scanGuidance";

interface Props {
  /**
   * Label of the target this surface registered (e.g. `wms:pack.carton` or
   * a legacy `receiving-workspace.item`). When another target owns the
   * stream the operator is told, in plain words, that scans go elsewhere.
   */
  expectedLabel?: string;
  /** Override the intent-derived instruction. */
  hint?: string;
  /** Compact single-line bar for the RF layout; default is the desktop block. */
  variant?: "block" | "bar";
  /** Show the last-five strip. Default: on for the block, off for the bar. */
  showHistory?: boolean;
  /** Hide the camera action (the surface already has its own button). */
  hideCamera?: boolean;
  /** Keep the viewfinder open between decodes. */
  continuous?: boolean;
  className?: string;
}

const VERDICT_ICON: Record<ScanVerdict, typeof CheckCircle2> = {
  accepted: CheckCircle2,
  duplicate: Copy,
  wrong_kind: XCircle,
  unknown: HelpCircle,
};

const VERDICT_TONE: Record<ScanVerdict, string> = {
  accepted: "text-success",
  duplicate: "text-warning",
  wrong_kind: "text-destructive",
  unknown: "text-muted-foreground",
};

export function ScanGuidance({ expectedLabel, hint, variant = "block", showHistory, hideCamera, continuous, className }: Props) {
  const target = useActiveScanTarget();
  const history = useScanHistory();
  const { handheld } = useLocalScan();
  const [lastSource, setLastSource] = useState<ScanEvent["source"] | null>(null);
  const [last, setLast] = useState<{ verdict: ScanVerdict; raw: string; detail?: string } | null>(null);

  // The live input is whichever transport last delivered a decode; before
  // the first scan we fall back to what this device can offer.
  useEffect(() => scanBus.on((e) => setLastSource(e.source)), []);
  useEffect(
    () =>
      scanFeedbackBus.on((f) => {
        if (f.kind === "pending") return;
        setLast({ verdict: classifyFeedback(f.kind, f.detail), raw: f.raw, detail: f.detail });
      }),
    [],
  );

  const activeIntent = intentFromTargetLabel(target?.label);
  const prompt = promptForIntent(activeIntent);
  const armed = expectedLabel ? target?.label === expectedLabel : target !== null;
  const otherOwner = target?.label && expectedLabel && target.label !== expectedLabel ? target.label : null;

  const instruction = hint ?? prompt?.what ?? (armed ? "Ready to scan" : "No scan prompt is active");
  const sourceText = describeScanSource(lastSource ?? (handheld ? "camera" : null));
  const withHistory = showHistory ?? variant === "block";

  const Icon = last ? VERDICT_ICON[last.verdict] : null;

  const statusLine = otherOwner ? (
    <span className="flex min-w-0 items-center gap-1 text-warning">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">Scans are going to another open panel — close it to scan here</span>
    </span>
  ) : (
    <span className={cn("flex min-w-0 items-center gap-1", armed ? "text-foreground" : "text-muted-foreground")}>
      <ScanLine className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{instruction}</span>
    </span>
  );

  if (variant === "bar") {
    return (
      <div
        className={cn(
          "flex w-full min-w-0 max-w-full items-center justify-between gap-2 overflow-hidden rounded-md border bg-muted/40 px-2 py-1.5 text-xs",
          className,
        )}
        role="status"
        aria-live="polite"
      >
        <div className="min-w-0 flex-1 font-medium">{statusLine}</div>
        <div className="flex shrink-0 items-center gap-1.5">
          {last && Icon && (
            <span className={cn("inline-flex shrink-0 items-center gap-1", VERDICT_TONE[last.verdict])}>
              <Icon className="h-3.5 w-3.5" />
              <span className="font-mono max-w-[8rem] truncate">{last.raw || "—"}</span>
            </span>
          )}
          {!hideCamera && (
            <ScanCameraButton label={instruction} continuous={continuous} className="h-7 w-7" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("w-full min-w-0 max-w-full overflow-hidden rounded-md border bg-muted/30 p-2 text-xs", className)}
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 font-medium">{statusLine}</div>
        <span className="shrink-0 text-muted-foreground">{sourceText}</span>
      </div>
      {!hideCamera && (
        <ScanCameraButton
          label={instruction}
          continuous={continuous}
          withText
          className="mt-2 h-11 w-full text-sm sm:mt-1.5 sm:h-8 sm:w-auto sm:text-xs"
        />
      )}
      {armed && prompt && !otherOwner && (
        <div className="mt-0.5 text-muted-foreground">{prompt.then}</div>
      )}
      {last && Icon && (
        <div className={cn("mt-1 flex min-w-0 flex-wrap items-center gap-1", VERDICT_TONE[last.verdict])}>
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span>{verdictCopy(last.verdict)}</span>
          <span className="min-w-0 truncate font-mono">{last.raw.slice(0, 24) || "—"}</span>
          {last.detail && <span className="truncate max-w-[18rem] text-muted-foreground">{last.detail}</span>}
        </div>
      )}
      {withHistory && history.length > 0 && <ScanHistoryStrip entries={history} />}
    </div>
  );
}

function ScanHistoryStrip({ entries }: { entries: ScanHistoryEntry[] }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5 border-t pt-1.5" aria-label="Recent scans">
      {entries.map((e) => {
        const Icon = VERDICT_ICON[e.verdict];
        return (
          <li
            key={e.key}
            title={`${verdictCopy(e.verdict)}${e.detail ? ` — ${e.detail}` : ""}`}
            className={cn(
              "inline-flex max-w-full items-center gap-1 truncate rounded border px-1.5 py-0.5 font-mono",
              VERDICT_TONE[e.verdict],
            )}
          >
            <Icon className="h-3 w-3" />
            {e.raw.slice(0, 16) || "—"}
          </li>
        );
      })}
    </ul>
  );
}

export default ScanGuidance;
