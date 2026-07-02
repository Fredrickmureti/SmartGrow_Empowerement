/**
 * AttendanceClockWidget — check-in/out toggle with breaks + OT request.
 * Used in both self-service (/me/attendance) and manager view.
 */
import { useState, useEffect } from "react";
import { LogIn, LogOut, Loader2, Clock, Coffee, Play, PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Input } from "@/components/ui/input";

import { Textarea } from "@/components/ui/textarea";
import { useAttendanceStatus } from "@/hooks/hr/useAttendanceStatus";
import { useAttendanceActions } from "@/hooks/hr/useAttendanceActions";
import { useAttendanceSettings } from "@/hooks/hr/useAttendanceSettings";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { LateReasonDialog } from "@/components/attendance/LateReasonDialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

function formatElapsed(checkInISO: string): string {
  const diff = Date.now() - new Date(checkInISO).getTime();
  const totalMinutes = Math.floor(diff / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

const BREAK_TYPES = [
  { value: "rest", label: "Rest" },
  { value: "meal", label: "Meal" },
  { value: "personal", label: "Personal" },
  { value: "other", label: "Other" },
];

export function AttendanceClockWidget() {
  const { status, isLoading: statusLoading } = useAttendanceStatus();
  const {
    clockIn,
    clockInAsync,
    clockOut,
    startBreak,
    endBreak,
    requestOvertime,
    isClockingIn,
    isClockingOut,
    isStartingBreak,
    isEndingBreak,
  } = useAttendanceActions();
  const { settings } = useAttendanceSettings();
  const { currentEmployee } = useCurrentEmployee();
  const [elapsed, setElapsed] = useState("");
  const [breakElapsed, setBreakElapsed] = useState("");

  // Break start dialog
  const [breakOpen, setBreakOpen] = useState(false);
  const [breakType, setBreakType] = useState("rest");
  const [breakNotes, setBreakNotes] = useState("");

  // OT dialog
  const [otOpen, setOtOpen] = useState(false);
  const [otDate, setOtDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [otHours, setOtHours] = useState("1");
  const [otReason, setOtReason] = useState("");

  // Late-reason dialog — opened post-clock-in when the row came back late
  // and the org has require_late_reason enabled.
  const [lateOpen, setLateOpen] = useState(false);
  const [lateTarget, setLateTarget] = useState<{
    attendanceId: string;
    lateMinutes: number;
  } | null>(null);

  /**
   * Clock in via the async mutation so we can branch on the returned
   * attendance UUID. If the org requires a late reason and the new row's
   * late_minutes > 0, open LateReasonDialog (non-blocking; the user can
   * still skip).
   */
  const handleClockIn = async () => {
    if (!currentEmployee) return;
    try {
      const attendanceId = await clockInAsync(currentEmployee.id);
      if (!attendanceId || typeof attendanceId !== "string") return;
      if (!settings?.require_late_reason) return;
      const { data } = await supabase
        .from("attendance")
        .select("late_minutes")
        .eq("id", attendanceId)
        .maybeSingle();
      const lateMinutes = (data as any)?.late_minutes ?? 0;
      if (lateMinutes > 0) {
        setLateTarget({ attendanceId, lateMinutes });
        setLateOpen(true);
      }
    } catch {
      /* errors already toasted by the mutation */
    }
  };

  useEffect(() => {
    if (!status.currentSession) {
      setElapsed("");
      return;
    }
    const update = () => setElapsed(formatElapsed(status.currentSession!.clock_in));
    update();
    const interval = setInterval(update, 30_000);
    return () => clearInterval(interval);
  }, [status.currentSession]);

  useEffect(() => {
    if (!status.currentBreak) {
      setBreakElapsed("");
      return;
    }
    const update = () => setBreakElapsed(formatElapsed(status.currentBreak!.started_at));
    update();
    const interval = setInterval(update, 30_000);
    return () => clearInterval(interval);
  }, [status.currentBreak]);

  if (!currentEmployee) return null;

  const isBusy = isClockingIn || isClockingOut || statusLoading;
  const onBreak = !!status.currentBreak;

  const handleStartBreak = () => {
    if (!status.currentSession) return;
    startBreak({
      attendance_id: status.currentSession.id,
      break_type: breakType,
      notes: breakNotes.trim() || null,
    });
    setBreakOpen(false);
    setBreakNotes("");
  };

  const handleEndBreak = () => {
    if (status.currentBreak) endBreak(status.currentBreak.id);
  };

  const handleRequestOt = () => {
    const hours = parseFloat(otHours);
    if (!hours || hours <= 0) {
      toast.error("Enter a positive hours value");
      return;
    }
    requestOvertime({
      employee_id: currentEmployee.id,
      ot_date: otDate,
      hours,
      reason: otReason.trim() || undefined,
    });
    setOtOpen(false);
    setOtReason("");
    setOtHours("1");
  };

  return (
    <Card className="border-2 border-primary/20">
      <CardContent className="p-4 sm:p-6">
        <div className="flex flex-col sm:flex-row items-center gap-4">
          {/* Status indicator */}
          <div className="flex items-center gap-3">
            <div
              className={`h-3 w-3 rounded-full ${
                onBreak
                  ? "bg-amber-500 animate-pulse"
                  : status.isCheckedIn
                  ? "bg-emerald-500 animate-pulse"
                  : "bg-muted-foreground/40"
              }`}
            />
            <div>
              <p className="text-sm font-medium">
                {onBreak
                  ? `On break (${status.currentBreak?.break_type})`
                  : status.isCheckedIn
                  ? "Checked In"
                  : "Not Checked In"}
              </p>
              {onBreak && breakElapsed ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Coffee className="h-3 w-3" />
                  Break {breakElapsed}
                </p>
              ) : status.isCheckedIn && elapsed ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Since {elapsed} ago
                </p>
              ) : null}
            </div>
          </div>

          {/* Today's total */}
          <div className="text-center sm:text-left sm:ml-auto">
            <p className="text-xs text-muted-foreground">Today Total</p>
            <p className="text-lg font-semibold">
              {status.todayTotalHours.toFixed(1)}h
            </p>
          </div>

          {/* Action buttons — primary (clock) + secondary (break/OT) split.
              On phones primary stacks full-width above secondary. */}
          <div className="w-full sm:w-auto flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap sm:justify-center">
            {/* Primary action — Clock In / Out (or End Break) */}
            <div className="flex">
              {status.isCheckedIn ? (
                <Button
                  onClick={() => clockOut(currentEmployee.id)}
                  disabled={isBusy || onBreak}
                  size="lg"
                  className="w-full sm:w-auto min-w-[160px]"
                  title={onBreak ? "End your break before clocking out" : undefined}
                >
                  {isClockingOut ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <LogOut className="h-4 w-4 mr-2" />
                  )}
                  Clock Out
                </Button>
              ) : (
                <Button
                  onClick={handleClockIn}
                  disabled={isBusy}
                  size="lg"
                  className="w-full sm:w-auto min-w-[160px] bg-emerald-600 hover:bg-emerald-700"
                >
                  {isClockingIn ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <LogIn className="h-4 w-4 mr-2" />
                  )}
                  Clock In
                </Button>
              )}
            </div>

            {/* Secondary actions row */}
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
              {status.isCheckedIn && !onBreak && (
                <Button
                  onClick={() => setBreakOpen(true)}
                  disabled={isBusy || isStartingBreak}
                  variant="outline"
                  size="lg"
                >
                  <Coffee className="h-4 w-4 mr-2" />
                  Start Break
                </Button>
              )}
              {onBreak && (
                <Button
                  onClick={handleEndBreak}
                  disabled={isEndingBreak}
                  variant="outline"
                  size="lg"
                >
                  {isEndingBreak ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Play className="h-4 w-4 mr-2" />
                  )}
                  End Break
                </Button>
              )}
              <Button
                onClick={() => setOtOpen(true)}
                variant="secondary"
                size="lg"
                aria-label="Request overtime hours"
              >
                <PlusCircle className="h-4 w-4 mr-2" />
                Request OT
              </Button>
            </div>
          </div>
        </div>


        {/* Today's sessions */}
        {status.todaySessions.length > 0 && (
          <div className="mt-4 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Today's Sessions ({status.todaySessions.length})
            </p>
            <div className="space-y-1">
              {status.todaySessions.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between text-sm px-2 py-1 rounded bg-muted/50"
                >
                  <span>
                    {s.clock_in
                      ? new Date(s.clock_in).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—"}{" "}
                    →{" "}
                    {s.clock_out
                      ? new Date(s.clock_out).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "Active"}
                  </span>
                  <span className="text-muted-foreground">
                    {s.worked_hours ? `${s.worked_hours.toFixed(1)}h` : "—"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {/* Start break — WorkflowSheet */}
      <WorkflowSheet
        open={breakOpen}
        onOpenChange={setBreakOpen}
        size="md"
        title="Start break"
        description="Pause the working clock. Resume it from the same widget when you're back."
        footer={
          <>
            <Button variant="ghost" onClick={() => setBreakOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleStartBreak} disabled={isStartingBreak}>
              {isStartingBreak && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Start
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Break details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Type" htmlFor="break-type">
              <select
                id="break-type"
                className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                value={breakType}
                onChange={(e) => setBreakType(e.target.value)}
              >
                {BREAK_TYPES.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </WorkflowField>
            <WorkflowField label="Notes" htmlFor="break-notes" hint="Optional">
              <Textarea
                id="break-notes"
                rows={2}
                value={breakNotes}
                onChange={(e) => setBreakNotes(e.target.value)}
              />
            </WorkflowField>
          </div>
        </WorkflowSheetSection>
      </WorkflowSheet>

      {/* Overtime request — WorkflowSheet */}
      <WorkflowSheet
        open={otOpen}
        onOpenChange={setOtOpen}
        size="md"
        title="Request overtime"
        description="Submit extra hours for manager approval. Approved hours flow into payroll."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOtOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRequestOt}>Submit request</Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="When">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Date" htmlFor="ot-date">
              <Input
                id="ot-date"
                type="date"
                value={otDate}
                onChange={(e) => setOtDate(e.target.value)}
              />
            </WorkflowField>
            <WorkflowField label="Hours" htmlFor="ot-hours">
              <Input
                id="ot-hours"
                type="number"
                step="0.25"
                min="0.25"
                value={otHours}
                onChange={(e) => setOtHours(e.target.value)}
              />
            </WorkflowField>
          </div>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Justification">
          <WorkflowField label="Reason" htmlFor="ot-reason" required>
            <Textarea
              id="ot-reason"
              rows={3}
              value={otReason}
              onChange={(e) => setOtReason(e.target.value)}
              placeholder="Why are these extra hours needed?"
            />
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheet>

      {/* Late reason capture — opens after clock-in if the row came back
          late and the org has require_late_reason enabled. */}
      <LateReasonDialog
        attendanceId={lateTarget?.attendanceId ?? null}
        lateMinutes={lateTarget?.lateMinutes ?? null}
        open={lateOpen}
        onOpenChange={(o) => {
          setLateOpen(o);
          if (!o) setLateTarget(null);
        }}
      />
    </Card>
  );
}
