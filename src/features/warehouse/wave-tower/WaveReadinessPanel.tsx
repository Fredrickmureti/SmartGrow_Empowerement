/**
 * Readiness panel — the server's release verdict, check by check.
 *
 * Renders `wms_wave_readiness` output. The client never re-derives whether
 * a wave may be released; it mirrors the same rule the release RPC enforces.
 */
import { AlertTriangle, CheckCircle2, CircleSlash, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CHECK_LABEL, MODE_LABEL, READINESS_LABEL, type ReadinessState, type WaveReadiness,
} from "./contract";
import { toneText } from "@/design-system";

const ICON: Record<ReadinessState, typeof CheckCircle2> = {
  ready: CheckCircle2,
  at_risk: AlertTriangle,
  blocked: CircleSlash,
  unknown: HelpCircle,
};

const TONE: Record<ReadinessState, string> = {
  ready: toneText("success"),
  at_risk: toneText("warning"),
  blocked: toneText("danger"),
  unknown: toneText("neutral"),
};

export function WaveReadinessPanel({ readiness }: { readiness: WaveReadiness | null }) {
  if (!readiness) {
    return (
      <p className="text-xs text-muted-foreground">
        Not evaluated yet — run a readiness check to see stock, labour and departure cover.
      </p>
    );
  }

  return (
    <>
      {readiness.policy_name ? (
        <p className="mb-1 text-[11px] text-muted-foreground">
          Policy: {readiness.policy_name}
        </p>
      ) : null}
    <ul className="space-y-1.5">
      {readiness.checks.map((c) => {
        const Icon = ICON[c.state] ?? HelpCircle;
        return (
          <li key={c.check} className="flex items-start gap-2 text-xs">
            <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", TONE[c.state])} />
            <span className="min-w-0">
              <span className="font-medium">{CHECK_LABEL[c.check] ?? c.check}</span>
              <span className={cn("ml-2", TONE[c.state])}>{READINESS_LABEL[c.state]}</span>
              {c.mode && c.mode !== "block" ? (
                <span className="ml-2 text-muted-foreground">({MODE_LABEL[c.mode]})</span>
              ) : null}
              {c.reason ? (
                <span className="block text-muted-foreground">{c.reason}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
    </>
  );
}
