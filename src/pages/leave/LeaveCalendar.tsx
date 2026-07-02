/**
 * LeaveCalendar — full-page team leave calendar.
 *
 * Promotes the TeamLeaveCalendar component out of LeaveDashboard so it has a
 * stable deep-link (/hr/leave/calendar). Surfaces the ManagerTriageBanner so
 * a queue waiting on the viewer is one click away even from the calendar.
 */
import { useTeamLeaveRequests } from "@/hooks/leave";
import { TeamLeaveCalendar } from "@/components/leave/TeamLeaveCalendar";
import { Card, CardContent } from "@/components/ui/card";
import { Lock } from "lucide-react";
import { ManagerTriageBanner } from "@/components/hr/ManagerTriageBanner";

export default function LeaveCalendar() {
  const { allLeaveRequests, canApproveLeave, isManager } = useTeamLeaveRequests();

  if (!canApproveLeave && !isManager) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Lock className="h-8 w-8 text-muted-foreground mb-3" />
          <h3 className="font-semibold">Manager access required</h3>
          <p className="text-sm text-muted-foreground mt-1">
            The team calendar is visible to managers and HR.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <ManagerTriageBanner module="leave" />
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Team Leave Calendar</h1>
        <p className="text-sm text-muted-foreground">
          Visualize approved and pending time off across your team.
        </p>
      </div>
      <TeamLeaveCalendar leaveRequests={allLeaveRequests} />
    </div>
  );
}
