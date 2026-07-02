/**
 * EventOnlyDrawer — renders the full forensic chain for an (employee, day)
 * when no `attendance` day row exists (denied or out-of-band attempts).
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { EventEvidenceCard, type AttendanceEventEvidence } from "./EventEvidenceCard";

export function EventOnlyDrawer({
  employeeId,
  employeeName,
  employeeNumber,
  branchName,
  date,
  focusEventId,
  open,
  onOpenChange,
}: {
  employeeId: string;
  employeeName: string;
  employeeNumber?: string | null;
  branchName?: string | null;
  date: string;
  focusEventId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentOrg } = useOrganization();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["event-only-drawer", currentOrg?.id, employeeId, date],
    enabled: !!currentOrg?.id && open,
    refetchInterval: open ? 30_000 : false,
    queryFn: async (): Promise<AttendanceEventEvidence[]> => {
      const fromTs = new Date(`${date}T00:00:00`).toISOString();
      const toTs = new Date(`${date}T23:59:59.999`).toISOString();
      const { data, error } = await supabase.rpc("attendance_events_search" as any, {
        _organization_id: currentOrg!.id,
        _business_id: null,
        _branch_id: null,
        _from: fromTs,
        _to: toTs,
        _employee_id: employeeId,
        _decisions: null,
        _reasons: null,
        _event_types: null,
        _limit: 100,
        _before: null,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((e) => ({
        id: e.id,
        // Prefer truthful device event_time; fall back to server received time.
        occurred_at: e.effective_time ?? e.event_time ?? e.created_at,
        created_at: e.effective_time ?? e.event_time ?? e.created_at,
        event_type: e.event_type,
        source: e.source,
        decision: e.decision,
        reason: e.reason,
        lat: e.lat,
        lng: e.lng,
        accuracy_m: e.accuracy_m,
        ip: e.ip,
        user_agent: e.user_agent,
        device_fingerprint: e.device_fingerprint,
        selfie_path: e.selfie_path ?? null,
      }));
    },
  });

  useEffect(() => {
    if (!focusEventId || isLoading) return;
    const el = document.getElementById(`evt-${focusEventId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusEventId, isLoading, data]);

  const events = data ?? [];
  const latest = events[0];
  const latestAge = latest?.created_at ? Date.now() - new Date(latest.created_at).getTime() : Infinity;
  const isLive = latestAge < 60_000;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between gap-3">
            <span>{employeeName}</span>
            <Badge variant="outline">No clock-in recorded</Badge>
          </SheetTitle>
          <SheetDescription>
            {(() => {
              const d = new Date(date);
              return isNaN(d.getTime()) ? date : format(d, "EEEE, MMMM d, yyyy");
            })()}
            {branchName ? ` · ${branchName}` : ""}
            {employeeNumber ? ` · #${employeeNumber}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div ref={scrollRef} className="mt-4 space-y-3">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No events recorded for this employee on this day.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {events.length} event{events.length === 1 ? "" : "s"} captured. Each card includes the
                exact GPS fix, device fingerprint, IP and selfie (when available).
              </p>
              {events.map((e, i) => (
                <EventEvidenceCard
                  key={e.id}
                  event={e}
                  highlight={focusEventId === e.id}
                  live={i === 0 && isLive}
                />
              ))}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
