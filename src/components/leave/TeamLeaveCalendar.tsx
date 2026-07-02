import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, Users } from "lucide-react";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isWithinInterval, parseISO } from "date-fns";
import { LeaveRequest } from "@/hooks/leave/useLeaveRequests";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface TeamLeaveCalendarProps {
  leaveRequests: LeaveRequest[];
  month?: Date;
}

export function TeamLeaveCalendar({ leaveRequests, month = new Date() }: TeamLeaveCalendarProps) {
  const approvedRequests = leaveRequests.filter((r) => r.status === "approved");

  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Group leave by day
  const leaveByDay = useMemo(() => {
    const map = new Map<string, LeaveRequest[]>();

    approvedRequests.forEach((request) => {
      const start = parseISO(request.start_date);
      const end = parseISO(request.end_date);

      daysInMonth.forEach((day) => {
        if (isWithinInterval(day, { start, end }) || isSameDay(day, start) || isSameDay(day, end)) {
          const key = format(day, "yyyy-MM-dd");
          const existing = map.get(key) || [];
          if (!existing.find((r) => r.id === request.id)) {
            map.set(key, [...existing, request]);
          }
        }
      });
    });

    return map;
  }, [approvedRequests, daysInMonth]);

  // Get unique employees on leave this month
  const employeesOnLeave = useMemo(() => {
    const unique = new Map<string, LeaveRequest["employee"]>();
    approvedRequests.forEach((r) => {
      if (r.employee) {
        unique.set(r.employee.id, r.employee);
      }
    });
    return Array.from(unique.values());
  }, [approvedRequests]);

  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdaysShort = ["S", "M", "T", "W", "T", "F", "S"];

  // Calculate padding for first week
  const firstDayOfWeek = monthStart.getDay();

  return (
    <Card>
      <CardHeader className="pb-2 sm:pb-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Calendar className="h-4 w-4 sm:h-5 sm:w-5" />
              Team Calendar
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              {format(month, "MMMM yyyy")} - Approved time off
            </CardDescription>
          </div>
          <Badge variant="secondary" className="flex items-center gap-1 self-start sm:self-auto">
            <Users className="h-3 w-3" />
            {employeesOnLeave.length} on leave
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-2 sm:p-6 pt-0 sm:pt-0">
        {/* Calendar with horizontal scroll on mobile */}
        <ScrollArea className="w-full">
          <div className="min-w-[320px]">
            {/* Weekday headers */}
            <div className="grid grid-cols-7 gap-0.5 sm:gap-1 mb-1 sm:mb-2">
              {weekdays.map((day, index) => (
                <div
                  key={day}
                  className="text-center text-[10px] sm:text-xs font-medium text-muted-foreground py-1 sm:py-2"
                >
                  <span className="hidden sm:inline">{day}</span>
                  <span className="sm:hidden">{weekdaysShort[index]}</span>
                </div>
              ))}
            </div>

            {/* Calendar grid */}
            <div className="grid grid-cols-7 gap-0.5 sm:gap-1">
              {/* Empty cells for padding */}
              {Array.from({ length: firstDayOfWeek }).map((_, i) => (
                <div key={`empty-${i}`} className="aspect-square" />
              ))}

              {/* Day cells */}
              {daysInMonth.map((day) => {
                const key = format(day, "yyyy-MM-dd");
                const dayLeave = leaveByDay.get(key) || [];
                const isToday = isSameDay(day, new Date());
                const isWeekend = day.getDay() === 0 || day.getDay() === 6;

                return (
                  <div
                    key={key}
                    className={`
                      aspect-square p-0.5 sm:p-1 rounded-md border relative overflow-hidden
                      ${isToday ? "border-primary bg-primary/5" : "border-transparent"}
                      ${isWeekend ? "bg-muted/30" : ""}
                      ${dayLeave.length > 0 ? "bg-amber-50 dark:bg-amber-950/20" : ""}
                    `}
                  >
                    <div className={`text-[10px] sm:text-xs ${isToday ? "font-bold text-primary" : "text-muted-foreground"}`}>
                      {format(day, "d")}
                    </div>
                    {dayLeave.length > 0 && (
                      <div className="absolute bottom-0.5 left-0.5 right-0.5 sm:bottom-1 sm:left-1 sm:right-1">
                        {dayLeave.length <= 2 ? (
                          <div className="flex flex-col gap-0.5">
                            {dayLeave.map((req) => (
                              <div
                                key={req.id}
                                className="text-[6px] sm:text-[8px] truncate rounded px-0.5 sm:px-1"
                                style={{
                                  backgroundColor: req.leave_type?.color || "#3b82f6",
                                  color: "white",
                                }}
                                title={`${req.employee?.first_name} ${req.employee?.last_name}`}
                              >
                                {req.employee?.first_name?.[0]}{req.employee?.last_name?.[0]}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <Badge variant="secondary" className="text-[6px] sm:text-[8px] h-3 sm:h-4 px-0.5 sm:px-1">
                            {dayLeave.length} off
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <ScrollBar orientation="horizontal" className="sm:hidden" />
        </ScrollArea>

        {/* Legend */}
        {employeesOnLeave.length > 0 && (
          <div className="mt-3 sm:mt-4 pt-3 sm:pt-4 border-t">
            <p className="text-xs text-muted-foreground mb-2">Team members on leave this month:</p>
            <div className="flex flex-wrap gap-1 sm:gap-2">
              {employeesOnLeave.map((emp) => (
                <Badge key={emp?.id} variant="outline" className="text-[10px] sm:text-xs">
                  {emp?.first_name} {emp?.last_name}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
