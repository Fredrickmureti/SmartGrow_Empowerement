/**
 * EmployeeDayDrawer — canonical detail view for one employee on one day.
 *
 * Opened from any roster, report, audit, or live-presence row. Shows a
 * timeline of clock events, original-vs-effective times, the pending
 * correction request (if any) with inline approve/reject, recent
 * attendance_events, and permission-gated footer actions.
 *
 * Reuses existing hooks — no new RPCs.
 */
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { Clock, LogIn, LogOut, Coffee, Play, MapPin, Smartphone, ShieldCheck, AlertTriangle, Lock, FileEdit } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { usePermissions } from "@/hooks/usePermissions";
import { useAttendance, type AttendanceRecord } from "@/hooks/useAttendance";
import { useAttendanceSettings } from "@/hooks/hr/useAttendanceSettings";
import { AnomalyBadge } from "./AnomalyBadge";
import { detectAnomalies } from "@/lib/attendance/anomalies";
import { EventEvidenceCard, type AttendanceEventEvidence } from "./EventEvidenceCard";
import { cn } from "@/lib/utils";

export interface DayDrawerTarget {
  record: AttendanceRecord;
  employeeName: string;
  employeeNumber?: string | null;
  branchName?: string | null;
  /**
   * When true, hides manager actions even if the caller has permission
   * (used on the self-service `/me/attendance` surface).
   */
  selfServiceMode?: boolean;
  onRequestCorrection?: () => void;
  /** Event id to highlight + scroll to within the evidence list. */
  focusEventId?: string | null;
}

interface BreakRow {
  id: string;
  break_type: string | null;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
}

type EventRow = AttendanceEventEvidence;

export function EmployeeDayDrawer({
  target,
  open,
  onOpenChange,
}: {
  target: DayDrawerTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { can } = usePermissions();
  const { currentOrg } = useOrganization();
  const { settings } = useAttendanceSettings();
  const { reviewCorrection } = useAttendance();

  const record = target?.record ?? null;
  const isManager = can("manageAttendance") && !target?.selfServiceMode;

  const breaks = useQuery({
    queryKey: ["day-drawer-breaks", record?.id],
    enabled: !!record?.id && open,
    queryFn: async (): Promise<BreakRow[]> => {
      const { data, error } = await supabase
        .from("attendance_breaks" as any)
        .select("id, break_type, started_at, ended_at, duration_minutes")
        .eq("attendance_id", record!.id)
        .order("started_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as BreakRow[];
    },
  });

  const events = useQuery({
    queryKey: ["day-drawer-events", currentOrg?.id, record?.employee_id, record?.attendance_date],
    enabled: !!currentOrg?.id && !!record && open && isManager,
    queryFn: async (): Promise<EventRow[]> => {
      if (!currentOrg?.id || !record) return [];
      const fromTs = new Date(`${record.attendance_date}T00:00:00`).toISOString();
      const toTs = new Date(`${record.attendance_date}T23:59:59.999`).toISOString();
      const { data, error } = await supabase.rpc("attendance_events_search" as any, {
        _organization_id: currentOrg.id,
        _business_id: record.business_id ?? null,
        _branch_id: null,
        _from: fromTs,
        _to: toTs,
        _employee_id: record.employee_id,
        _decisions: null,
        _reasons: null,
        _event_types: null,
        _limit: 50,
        _before: null,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((e): EventRow => ({
        id: e.id,
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

  const pendingCorrection = useQuery({
    queryKey: ["day-drawer-correction", record?.id],
    enabled: !!record?.id && open && record?.correction_status === "pending",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attendance_corrections" as any)
        .select("id, proposed_clock_in, proposed_clock_out, reason, requested_at")
        .eq("attendance_id", record!.id)
        .eq("status", "pending")
        .order("requested_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });

  const anomalies = useMemo(() => {
    if (!record) return [];
    return detectAnomalies(record, settings);
  }, [record, settings]);

  // Scroll to focused event once the events query resolves.
  useEffect(() => {
    if (!open || !target?.focusEventId || events.isLoading) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`evt-${target.focusEventId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => clearTimeout(t);
  }, [open, target?.focusEventId, events.isLoading, events.data]);

  if (!record || !target) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="sm:max-w-xl" />
      </Sheet>
    );
  }

  const fmtTime = (iso: string | null | undefined) =>
    iso ? format(new Date(iso), "hh:mm a") : "—";

  const timeline: { kind: string; time: string; label: string; icon: any; tone: string }[] = [];
  if (record.clock_in) timeline.push({ kind: "in", time: record.clock_in, label: "Clock in", icon: LogIn, tone: "text-emerald-600" });
  (breaks.data ?? []).forEach((b) => {
    timeline.push({ kind: "break-start", time: b.started_at, label: `Break start${b.break_type ? ` · ${b.break_type}` : ""}`, icon: Coffee, tone: "text-amber-600" });
    if (b.ended_at) timeline.push({ kind: "break-end", time: b.ended_at, label: "Break end", icon: Play, tone: "text-amber-600" });
  });
  if (record.clock_out) timeline.push({ kind: "out", time: record.clock_out, label: "Clock out", icon: LogOut, tone: "text-rose-600" });
  timeline.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const proposed = pendingCorrection.data;
  const hasEdits =
    !!record.original_clock_in &&
    record.original_clock_in !== record.clock_in;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between gap-3">
            <span>{target.employeeName}</span>
            <Badge variant="secondary" className="capitalize">
              {record.status.replace("_", " ")}
            </Badge>
          </SheetTitle>
          <SheetDescription>
            {format(new Date(record.attendance_date), "EEEE, MMMM d, yyyy")}
            {target.branchName ? ` · ${target.branchName}` : ""}
            {target.employeeNumber ? ` · #${target.employeeNumber}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {/* Anomalies */}
          {anomalies.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Flags</p>
              <AnomalyBadge anomalies={anomalies} />
            </div>
          )}

          {/* Original vs Effective */}
          {hasEdits && (
            <Card className="border-amber-200 bg-amber-50/40 dark:border-amber-900/40 dark:bg-amber-900/10">
              <CardContent className="p-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Original</p>
                  <p className="tabular-nums">{fmtTime(record.original_clock_in)} → {fmtTime(record.original_clock_out)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Effective</p>
                  <p className="tabular-nums font-medium">{fmtTime(record.clock_in)} → {fmtTime(record.clock_out)}</p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Pending correction with inline diff */}
          {proposed && (
            <Card className="border-primary/40">
              <CardContent className="p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Pending correction</p>
                  <span className="text-[11px] text-muted-foreground">
                    {formatDistanceToNow(new Date(proposed.requested_at), { addSuffix: true })}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Current</p>
                    <p className="tabular-nums">{fmtTime(record.clock_in)} → {fmtTime(record.clock_out)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-primary">Proposed</p>
                    <p className="tabular-nums font-medium">{fmtTime(proposed.proposed_clock_in)} → {fmtTime(proposed.proposed_clock_out)}</p>
                  </div>
                </div>
                {proposed.reason && (
                  <p className="text-xs text-muted-foreground italic">"{proposed.reason}"</p>
                )}
                {isManager && (
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      onClick={() => reviewCorrection({ id: proposed.id, action: "approved" })}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => reviewCorrection({ id: proposed.id, action: "rejected" })}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Timeline */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Timeline</p>
            {timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No activity recorded.</p>
            ) : (
              <ol className="space-y-2">
                {timeline.map((t, i) => {
                  const Icon = t.icon;
                  return (
                    <li key={i} className="flex items-start gap-3 text-sm">
                      <div className={cn("mt-0.5 h-6 w-6 rounded-full border flex items-center justify-center bg-background", t.tone)}>
                        <Icon className="h-3 w-3" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium">{t.label}</p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {format(new Date(t.time), "hh:mm:ss a")}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          {/* Hours summary */}
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="rounded-md border p-2">
              <p className="text-[10px] uppercase text-muted-foreground">Worked</p>
              <p className="tabular-nums font-semibold">{(record.worked_hours ?? 0).toFixed(1)}h</p>
            </div>
            <div className="rounded-md border p-2">
              <p className="text-[10px] uppercase text-muted-foreground">Overtime</p>
              <p className="tabular-nums font-semibold">{(record.overtime_hours ?? 0).toFixed(1)}h</p>
            </div>
            <div className="rounded-md border p-2">
              <p className="text-[10px] uppercase text-muted-foreground">Breaks</p>
              <p className="tabular-nums font-semibold">{record.break_duration_minutes ?? 0}m</p>
            </div>
          </div>

          {/* Source + meta */}
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {record.clock_in_method && (
              <span className="inline-flex items-center gap-1">
                <Smartphone className="h-3 w-3" /> {record.clock_in_method}
              </span>
            )}
            {(record.clock_in_location || record.clock_out_location) && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" /> geo-tagged
              </span>
            )}
            {record.approved_by && (
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" /> approved
              </span>
            )}
            {record.is_locked && (
              <span className="inline-flex items-center gap-1">
                <Lock className="h-3 w-3" /> locked for payroll
              </span>
            )}
          </div>

          {/* Forensic evidence (manager only): every event with HD map, selfie, IP, device */}
          {isManager && (events.data?.length ?? 0) > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Forensic evidence ({events.data?.length})
                </p>
                <div className="space-y-3">
                  {(events.data ?? []).map((e, i) => {
                    const ts = e.created_at ? new Date(e.created_at).getTime() : 0;
                    const isLive = i === 0 && !record.clock_out && Date.now() - ts < 60_000;
                    return (
                      <EventEvidenceCard
                        key={e.id}
                        event={e}
                        highlight={target.focusEventId === e.id}
                        live={isLive}
                      />
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Footer actions */}
          <Separator />
          <div className="flex flex-wrap gap-2">
            {target.selfServiceMode && target.onRequestCorrection && !record.is_locked && record.correction_status === "none" && record.clock_out && (
              <Button variant="outline" size="sm" onClick={target.onRequestCorrection}>
                <FileEdit className="h-3.5 w-3.5 mr-1.5" />
                Request correction
              </Button>
            )}
            {record.is_locked && (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Locked by payroll — corrections disabled.
              </span>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
