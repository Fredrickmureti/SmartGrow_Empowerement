import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { LeaveType } from "@/hooks/leave/useLeaveTypes";

interface LeaveBalanceCardProps {
  leaveType: LeaveType;
  allocated?: number;
  used?: number;
  pending?: number;
}

export function LeaveBalanceCard({ leaveType, allocated = 0, used = 0, pending = 0 }: LeaveBalanceCardProps) {
  const remaining = allocated - used;
  const percentUsed = allocated > 0 ? (used / allocated) * 100 : 0;

  return (
    <Card>
      <CardHeader className="pb-2 p-3 sm:p-6 sm:pb-2">
        <CardTitle className="text-xs sm:text-sm font-medium flex items-center gap-2">
          <div 
            className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full flex-shrink-0" 
            style={{ backgroundColor: leaveType.color || "#3b82f6" }}
          />
          <span className="truncate">{leaveType.name}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 sm:p-6 pt-0 sm:pt-0">
        <div className="space-y-2 sm:space-y-3">
          <div className="flex justify-between text-xs sm:text-sm">
            <span className="text-muted-foreground">Available</span>
            <span className="font-semibold">{remaining} days</span>
          </div>
          <Progress value={percentUsed} className="h-1.5 sm:h-2" />
          <div className="flex justify-between text-[10px] sm:text-xs text-muted-foreground">
            <span>Used: {used} days</span>
            {pending > 0 && <span>Pending: {pending}</span>}
            <span>Total: {allocated} days</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
