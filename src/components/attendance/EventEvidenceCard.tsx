/**
 * EventEvidenceCard — per-event forensic detail: selfie, IP, UA, device
 * fingerprint, reason, decision, with embedded LocationTrailPanel when
 * coordinates are present.
 */
import { format } from "date-fns";
import { Smartphone, Globe, Fingerprint } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { LocationTrailPanel } from "./LocationTrailPanel";
import { useSelfieSignedUrl } from "@/hooks/attendance/useSelfieSignedUrl";
import { cn } from "@/lib/utils";

export interface AttendanceEventEvidence {
  id: string;
  occurred_at: string | null;
  created_at?: string | null;
  event_type: string | null;
  source: string | null;
  decision: string | null;
  reason: string | null;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  ip: string | null;
  user_agent: string | null;
  device_fingerprint: string | null;
  selfie_path: string | null;
}

const REASON_COPY: Record<string, string> = {
  OUTSIDE_GEOFENCE: "Outside the configured geofence radius.",
  GEO_REQUIRED: "Location was required but not provided.",
  NO_GEOFENCE_DEFINED: "No geofence defined for the branch.",
  SELFIE_REQUIRED: "A selfie was required and not captured.",
  UNTRUSTED_DEVICE: "Device is not trusted for this employee.",
  DEVICE_REVOKED: "Device trust was revoked.",
  IMPOSSIBLE_TRAVEL: "Distance vs. previous fix is physically impossible.",
  DUPLICATE_RECENT_ATTEMPT: "Another attempt was made within the throttle window.",
  OUTSIDE_SHIFT_WINDOW: "Outside of the shift's allowed clock window.",
  ON_APPROVED_LEAVE: "Employee is on approved leave today.",
  ALREADY_CLOCKED_IN: "Employee already has an open session.",
  KIOSK_PIN_INVALID: "Kiosk PIN was incorrect.",
};

function parseUA(ua: string | null) {
  if (!ua) return null;
  const os = /Windows/i.test(ua) ? "Windows"
    : /Mac OS/i.test(ua) ? "macOS"
    : /Android/i.test(ua) ? "Android"
    : /iPhone|iPad/i.test(ua) ? "iOS"
    : /Linux/i.test(ua) ? "Linux"
    : "Unknown OS";
  const br = /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox"
    : "Browser";
  return { os, browser: br };
}

export function EventEvidenceCard({
  event,
  highlight,
  live,
}: {
  event: AttendanceEventEvidence;
  highlight?: boolean;
  live?: boolean;
}) {
  const { data: selfieUrl } = useSelfieSignedUrl(event.selfie_path);
  const ua = parseUA(event.user_agent);
  const ts = event.occurred_at ?? event.created_at;
  const reasonHuman = event.reason ? REASON_COPY[event.reason] ?? null : null;

  const safeFmt = (iso: string | null | undefined) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : format(d, "HH:mm:ss");
  };

  return (
    <Card
      id={`evt-${event.id}`}
      className={cn(
        "scroll-mt-24 transition-colors",
        highlight && "ring-2 ring-primary",
      )}
    >
      <CardContent className="p-3 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{event.event_type ?? "event"}</span>
              {event.decision && (
                <Badge
                  variant={event.decision === "deny" ? "destructive" : event.decision === "flag" ? "outline" : "secondary"}
                  className="capitalize text-[10px]"
                >
                  {event.decision}
                </Badge>
              )}
              {event.source && (
                <Badge variant="outline" className="text-[10px]">{event.source}</Badge>
              )}
            </div>
            {event.reason && (
              <p className="text-xs text-muted-foreground mt-1">
                <span className="font-mono">{event.reason}</span>
                {reasonHuman && <span> — {reasonHuman}</span>}
              </p>
            )}
          </div>
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {safeFmt(ts)}
          </span>
        </div>

        {event.lat != null && event.lng != null && (
          <LocationTrailPanel
            fix={{
              lat: Number(event.lat),
              lng: Number(event.lng),
              accuracy_m: event.accuracy_m,
              capturedAt: ts,
              label: event.event_type,
              decision: event.decision,
              source: event.source,
            }}
            live={live}
          />
        )}

        {selfieUrl && (
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Selfie</p>
            <a href={selfieUrl} target="_blank" rel="noreferrer noopener">
              <img
                src={selfieUrl}
                alt="Captured selfie"
                className="h-32 w-32 rounded-md object-cover border"
              />
            </a>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground">
          {event.ip && (
            <div className="flex items-center gap-1.5 min-w-0">
              <Globe className="h-3 w-3 shrink-0" />
              <span className="font-mono truncate">{event.ip}</span>
            </div>
          )}
          {ua && (
            <div className="flex items-center gap-1.5 min-w-0">
              <Smartphone className="h-3 w-3 shrink-0" />
              <span className="truncate">{ua.browser} · {ua.os}</span>
            </div>
          )}
          {event.device_fingerprint && (
            <div className="flex items-center gap-1.5 min-w-0 col-span-full">
              <Fingerprint className="h-3 w-3 shrink-0" />
              <span className="font-mono truncate" title={event.device_fingerprint}>
                {event.device_fingerprint.slice(0, 24)}…
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
