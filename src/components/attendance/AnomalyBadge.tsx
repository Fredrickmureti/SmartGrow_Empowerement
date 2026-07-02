/**
 * AnomalyBadge — single-source pill for derived attendance anomalies.
 *
 * Wave-2: badge is clickable and opens a Popover explaining the rule that
 * fired and linking to the matching Attendance Settings tab. Renders
 * nothing when the anomaly list is empty.
 */
import { AlertTriangle, ExternalLink, Check } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Anomaly, AnomalyCode } from "@/lib/attendance/anomalies";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useState } from "react";

const TONE: Record<Anomaly["tone"], string> = {
  amber: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-900/50",
  rose: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-900/50",
  blue: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-900/50",
};

/** Per-code explanation + which settings tab to deep-link to. */
const RULE_INFO: Record<
  AnomalyCode,
  { why: string; settingsTab: "general" | "policies" | "trust" | "kiosk" }
> = {
  missing_out: {
    why: "Employee clocked in but never clocked out on a past day. The auto-checkout window may also apply.",
    settingsTab: "general",
  },
  late: {
    why: "Clock-in time was after the shift start (plus any grace period configured in Policies).",
    settingsTab: "policies",
  },
  early_leave: {
    why: "Clock-out was before the shift end. Threshold is configured in Policies.",
    settingsTab: "policies",
  },
  over_threshold: {
    why: "Worked hours exceeded the overtime threshold by more than 4 hours — review for accuracy.",
    settingsTab: "policies",
  },
  long_session: {
    why: "Open session is older than the auto-checkout window. The system did not auto-close it yet.",
    settingsTab: "general",
  },
  ot_no_preapproval: {
    why: "Settings require overtime to be pre-approved, but this row has overtime hours without an approved request.",
    settingsTab: "policies",
  },
};

export function AnomalyBadge({
  anomalies,
  compact = false,
  attendanceId,
  ackedCodes,
}: {
  anomalies: Anomaly[];
  compact?: boolean;
  /** When provided, enables per-code Acknowledge button (calls attendance_anomaly_ack RPC). */
  attendanceId?: string;
  /** Codes already acknowledged for this row — Acknowledge button hidden for these. */
  ackedCodes?: string[];
}) {
  if (!anomalies.length) return null;

  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const ack = async (code: string) => {
    if (!attendanceId) return;
    setBusy(code);
    const { error } = await (supabase as any).rpc("attendance_anomaly_ack", {
      _attendance_id: attendanceId,
      _codes: [code],
    });
    setBusy(null);
    if (error) {
      toast.error(error.message ?? "Could not acknowledge");
      return;
    }
    toast.success("Acknowledged");
    qc.invalidateQueries({ queryKey: ["attendance"] });
  };

  const trigger = compact ? (
    <button
      type="button"
      aria-label="Explain attendance flags"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex items-center gap-1 h-5 px-1.5 text-[10px] rounded-full border cursor-pointer hover:brightness-95",
        TONE[anomalies[0].tone],
      )}
    >
      <AlertTriangle className="h-3 w-3" />
      {anomalies.length > 1 ? `${anomalies.length} flags` : anomalies[0].label}
    </button>
  ) : (
    <button
      type="button"
      aria-label="Explain attendance flags"
      onClick={(e) => e.stopPropagation()}
      className="flex flex-wrap gap-1 cursor-pointer"
    >
      {anomalies.map((a) => (
        <span
          key={a.code}
          className={cn(
            "inline-flex items-center h-5 px-1.5 text-[10px] rounded-full border",
            TONE[a.tone],
          )}
        >
          {a.label}
        </span>
      ))}
    </button>
  );

  // Default to the first anomaly's settings tab; deep-link in the footer.
  const firstTab = RULE_INFO[anomalies[0].code]?.settingsTab ?? "policies";

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        className="w-72 p-3 space-y-2"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Why this is flagged
        </div>
        <ul className="space-y-2">
          {anomalies.map((a) => {
            const info = RULE_INFO[a.code];
            const alreadyAcked = ackedCodes?.includes(a.code);
            return (
              <li key={a.code} className="text-xs">
                <div className="flex items-center gap-1.5 font-medium">
                  <Badge
                    variant="outline"
                    className={cn("h-4 px-1.5 text-[10px]", TONE[a.tone])}
                  >
                    {a.label}
                  </Badge>
                  {attendanceId && (
                    alreadyAcked ? (
                      <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-600">
                        <Check className="h-3 w-3" /> acknowledged
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto h-6 px-2 text-[10px]"
                        disabled={busy === a.code}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          ack(a.code);
                        }}
                      >
                        Acknowledge
                      </Button>
                    )
                  )}
                </div>
                {info && <p className="text-muted-foreground mt-1">{info.why}</p>}
              </li>
            );
          })}
        </ul>
        <div className="pt-2 border-t">
          <Link
            to={`/hr/attendance/settings?tab=${firstTab}`}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Adjust settings
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
