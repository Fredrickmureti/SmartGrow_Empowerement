/**
 * MyAttendance — self-service surface at /me/attendance.
 *
 * Layout:
 *   • AttendanceClockWidget (live clock in/out + breaks + OT request)
 *   • Weekly KPI cards (hours / OT / sessions)
 *   • MyAttendanceSummaryTile (anomalies this month + assigned schedule)
 *   • Monthly status calendar (click a day → drawer; click a blank past
 *     working day → correction request directly)
 *   • My requests (pending and recent correction + overtime)
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { format, startOfWeek, endOfWeek } from "date-fns";
// Card import dropped — weekly tiles replaced by MyDayProgressCard.
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { ManagerTriageBanner } from "@/components/hr/ManagerTriageBanner";
import { PageHeader, PageBody } from "@/design-system";
import { AttendanceClockWidget } from "@/components/attendance/AttendanceClockWidget";
import { CorrectionRequestDialog } from "@/components/attendance/CorrectionRequestDialog";
import { MyAttendanceCalendar } from "@/components/attendance/MyAttendanceCalendar";
import { MyAttendanceRequests } from "@/components/attendance/MyAttendanceRequests";
import { MyDayProgressCard } from "@/components/attendance/MyDayProgressCard";
import { MyRequestDecisions } from "@/components/attendance/MyRequestDecisions";
import { MyAttendanceSummaryTile } from "@/components/attendance/MyAttendanceSummaryTile";
import { MyWeekStrip } from "@/components/attendance/MyWeekStrip";
import { useAttendanceActions } from "@/hooks/hr/useAttendanceActions";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useMyAttendance } from "@/hooks/hr/useMyAttendance";
import { useMyShiftToday } from "@/hooks/hr/useMyShiftToday";
import { useAttendanceInboxCounts } from "@/hooks/hr/useAttendanceInboxCounts";
import { usePermissions } from "@/hooks/usePermissions";
import type { AttendanceRecord } from "@/hooks/useAttendance";


export default function MyAttendance() {
  const [correctionRecord, setCorrectionRecord] = useState<AttendanceRecord | null>(null);
  const today = new Date();
  const weekStart = format(startOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd");
  const weekEnd = format(endOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd");

  const { records: weekRecords } = useMyAttendance({ from: weekStart, to: weekEnd });
  const { requestCorrection } = useAttendanceActions();
  const { currentEmployee, isManager } = useCurrentEmployee();
  const { scheduleName, standardHoursPerDay } = useMyShiftToday();
  const { counts: inboxCounts } = useAttendanceInboxCounts();
  const { can } = usePermissions();
  const canManageAttendance = can("manageAttendance");
  const calendarRef = useRef<HTMLDivElement | null>(null);

  // Phase 4 P4 — landing from `/me/attendance?date=YYYY-MM-DD`:
  // switch to the History tab and scroll the calendar into view so the
  // date driving the payslip line is visible without scrubbing.
  const [searchParams] = useSearchParams();
  const dateAnchor = searchParams.get("date");
  const [activeTab, setActiveTab] = useState<string>(dateAnchor ? "history" : "today");
  useEffect(() => {
    if (!dateAnchor) return;
    const handle = requestAnimationFrame(() => {
      calendarRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(handle);
  }, [dateAnchor]);


  const weeklyHours = weekRecords.reduce((s, r) => s + (r.worked_hours || 0), 0);
  const weeklyOvertime = weekRecords.reduce((s, r) => s + (r.overtime_hours || 0), 0);

  const employeeName = currentEmployee
    ? `${currentEmployee.first_name} ${currentEmployee.last_name}`
    : "You";

  /** Synthesize a blank record so the correction dialog can ask for proposed
      times on a day the employee never clocked in. */
  const startBlankCorrection = (date: string) => {
    if (!currentEmployee) return;
    const synthetic: AttendanceRecord = {
      id: `blank-${date}`,
      employee_id: currentEmployee.id,
      attendance_date: date,
      clock_in: null,
      clock_out: null,
      status: "absent",
      worked_hours: 0,
      overtime_hours: 0,
      late_minutes: 0,
      notes: null,
      branch_id: null,
      employee: {
        first_name: currentEmployee.first_name,
        last_name: currentEmployee.last_name,
        employee_number: currentEmployee.employee_number,
      },
    } as unknown as AttendanceRecord;
    setCorrectionRecord(synthetic);
  };

  return (
    <>
      <PageHeader
        title="My Attendance"
        description="Clock in/out, review your month, and follow your requests."
      />
      <PageBody>
        {/* B4: Manager triage banner — surfaces pending team approvals so a
          team lead doesn't need to leave the personal portal to notice them.
          Permission/total gating is also re-checked by the banner itself,
          but the outer guard preserves the architecture invariant. */}
      {isManager && canManageAttendance && inboxCounts.total > 0 && (
        <ManagerTriageBanner module="attendance" />
      )}



      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="today">Today</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="today" className="mt-4 space-y-6">
          <MyRequestDecisions />

          <div className="sm:static sticky top-0 z-20 bg-background sm:bg-transparent -mx-4 px-4 sm:mx-0 sm:px-0 pt-2 sm:pt-0 pb-2 sm:pb-0 border-b sm:border-b-0">
            <AttendanceClockWidget />
          </div>

          <MyDayProgressCard
            weeklyHours={weeklyHours}
            weeklyOvertime={weeklyOvertime}
            weeklySessions={weekRecords.length}
          />


          <MyWeekStrip
            onDayClick={(date, inFuture) => {
              if (!inFuture) startBlankCorrection(date);
            }}
          />
        </TabsContent>

        <TabsContent value="history" className="mt-4 space-y-6">
          <Tabs defaultValue="calendar">
            <TabsList>
              <TabsTrigger value="calendar">Calendar</TabsTrigger>
              <TabsTrigger value="requests">Requests</TabsTrigger>
              <TabsTrigger value="stats">Stats</TabsTrigger>
            </TabsList>
            <TabsContent value="calendar" className="mt-4">
              <div ref={calendarRef}>
                <MyAttendanceCalendar
                  employeeName={employeeName}
                  onRequestCorrection={(record) => setCorrectionRecord(record)}
                  onRequestBlankCorrection={startBlankCorrection}
                />
              </div>
            </TabsContent>
            <TabsContent value="requests" className="mt-4">
              <MyAttendanceRequests />
            </TabsContent>
            <TabsContent value="stats" className="mt-4">
              <MyAttendanceSummaryTile
                standardHoursPerDay={standardHoursPerDay}
                scheduleName={scheduleName}
                onSeeFlagged={() =>
                  calendarRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              />
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>

      {correctionRecord && (
        <CorrectionRequestDialog
          record={correctionRecord}
          open={!!correctionRecord}
          onOpenChange={(open) => !open && setCorrectionRecord(null)}
          onSubmit={(data) => {
            const isBlank = correctionRecord.id.startsWith("blank-");
            requestCorrection({
              // Blank synthetic rows must not pass a non-existent attendance_id.
              attendance_id: isBlank ? null : correctionRecord.id,
              employee_id: correctionRecord.employee_id,
              attendance_date: correctionRecord.attendance_date,
              proposed_clock_in: data.newClockIn ?? null,
              proposed_clock_out: data.newClockOut ?? null,
              reason: data.reason,
            });
            setCorrectionRecord(null);
          }}
        />
      )}
      </PageBody>
    </>
  );
}
