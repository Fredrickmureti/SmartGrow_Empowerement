/**
 * EmployeeDayDrawerByLookup — open the canonical EmployeeDayDrawer when
 * the caller only has an (employee_id, date) tuple (e.g. an audit row).
 *
 * Strategy:
 *  - Always fetch BOTH the day's attendance row AND the day's event chain.
 *  - If an attendance row exists, render the canonical EmployeeDayDrawer.
 *  - If only events exist (denied / out-of-band attempts), render the
 *    EventOnlyDrawer with full forensic evidence (HD map, selfie, IP, UA,
 *    device, reason) — never a dead-end message.
 */
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import type { AttendanceRecord } from "@/hooks/useAttendance";
import { EmployeeDayDrawer } from "./EmployeeDayDrawer";
import { EventOnlyDrawer } from "./EventOnlyDrawer";

export interface LookupTarget {
  employeeId: string;
  date: string; // yyyy-MM-dd
  employeeName: string;
  employeeNumber?: string | null;
  branchName?: string | null;
  /** Optional event id to focus/scroll within the event chain. */
  focusEventId?: string | null;
}

export function EmployeeDayDrawerByLookup({
  target,
  open,
  onOpenChange,
}: {
  target: LookupTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentOrg } = useOrganization();

  const { data: record, isLoading } = useQuery<AttendanceRecord | null>({
    queryKey: ["attendance-lookup", currentOrg?.id, target?.employeeId, target?.date],
    enabled: !!target && !!currentOrg?.id && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attendance")
        .select(
          "*, employee:employees!attendance_employee_id_fkey(id, first_name, last_name, employee_number, department)",
        )
        .eq("organization_id", currentOrg!.id)
        .eq("employee_id", target!.employeeId)
        .eq("attendance_date", target!.date)
        .maybeSingle();
      if (error) throw error;
      return (data as any) ?? null;
    },
  });

  if (!target) return null;

  if (isLoading) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-xl">
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  if (!record) {
    return (
      <EventOnlyDrawer
        employeeId={target.employeeId}
        employeeName={target.employeeName}
        employeeNumber={target.employeeNumber}
        branchName={target.branchName}
        date={target.date}
        focusEventId={target.focusEventId ?? null}
        open={open}
        onOpenChange={onOpenChange}
      />
    );
  }

  return (
    <EmployeeDayDrawer
      target={{
        record,
        employeeName: target.employeeName,
        employeeNumber: target.employeeNumber,
        branchName: target.branchName,
        focusEventId: target.focusEventId ?? null,
      }}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
