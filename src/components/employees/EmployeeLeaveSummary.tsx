import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useLeaveAllocations, LeaveBalance } from "@/hooks/leave/useLeaveAllocations";
import { useLeaveTypes } from "@/hooks/leave/useLeaveTypes";
import { LeaveBalanceCard } from "@/components/leave/LeaveBalanceCard";
import { Loader2 } from "lucide-react";

interface Props {
  employeeId: string;
}

export function EmployeeLeaveSummary({ employeeId }: Props) {
  const { getEmployeeBalances } = useLeaveAllocations();
  const { leaveTypes } = useLeaveTypes();
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    getEmployeeBalances(employeeId)
      .then(setBalances)
      .finally(() => setIsLoading(false));
  }, [employeeId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (leaveTypes.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          No leave types configured.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
      {leaveTypes.map((type) => {
        const balance = balances.find(b => b.leave_type_id === type.id);
        return (
          <LeaveBalanceCard
            key={type.id}
            leaveType={type}
            allocated={balance?.allocated ?? 0}
            used={balance?.used ?? 0}
            pending={balance?.pending ?? 0}
          />
        );
      })}
    </div>
  );
}
