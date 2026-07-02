import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, AlertTriangle } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useLeaveTypes, useLeaveRequests } from "@/hooks/leave";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import {
  useLeaveAllocations,
  LeaveBalance,
} from "@/hooks/leave/useLeaveAllocations";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

interface LeaveRequestFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LeaveRequestForm({ open, onOpenChange }: LeaveRequestFormProps) {
  const { leaveTypes } = useLeaveTypes();
  const { createLeaveRequest, calculateLeaveDays } = useLeaveRequests();
  const { currentEmployee } = useCurrentEmployee();
  const { getEmployeeBalances } = useLeaveAllocations();

  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startDate, setStartDate] = useState<Date>();
  const [endDate, setEndDate] = useState<Date>();
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [calculatedDays, setCalculatedDays] = useState<number | null>(null);
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalance[]>([]);
  const [insufficientBalance, setInsufficientBalance] = useState(false);

  useEffect(() => {
    if (open && currentEmployee?.id) {
      getEmployeeBalances(currentEmployee.id).then(setLeaveBalances);
    }
  }, [open, currentEmployee?.id]);

  useEffect(() => {
    if (!leaveTypeId || calculatedDays === null) {
      setInsufficientBalance(false);
      return;
    }
    const balance = leaveBalances.find((b) => b.leave_type_id === leaveTypeId);
    const available = balance ? balance.available - balance.pending : 0;
    setInsufficientBalance(calculatedDays > available);
  }, [leaveTypeId, calculatedDays, leaveBalances]);

  useEffect(() => {
    if (!startDate || !endDate) {
      setCalculatedDays(null);
      return;
    }
    let cancelled = false;
    calculateLeaveDays(
      format(startDate, "yyyy-MM-dd"),
      format(endDate, "yyyy-MM-dd"),
      "full",
      "full",
    ).then((days) => {
      if (!cancelled) setCalculatedDays(days);
    });
    return () => {
      cancelled = true;
    };
  }, [startDate, endDate, calculateLeaveDays]);

  const resetForm = () => {
    setLeaveTypeId("");
    setStartDate(undefined);
    setEndDate(undefined);
    setReason("");
    setCalculatedDays(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leaveTypeId || !startDate || !endDate || !currentEmployee) {
      if (!currentEmployee) {
        toast.error("No employee record found for your account");
      }
      return;
    }
    const days = calculatedDays ?? 0;
    setIsSubmitting(true);
    try {
      await createLeaveRequest({
        leave_type_id: leaveTypeId,
        employee_id: currentEmployee.id,
        business_id: null,
        start_date: format(startDate, "yyyy-MM-dd"),
        end_date: format(endDate, "yyyy-MM-dd"),
        start_period: "full",
        end_period: "full",
        days_requested: days,
        reason: reason || null,
        attachment_url: null,
        status: "pending",
        submitted_at: new Date().toISOString(),
        first_approver_id: null,
        first_approval_at: null,
        second_approver_id: null,
        second_approval_at: null,
        created_by: currentEmployee.user_id || null,
        rejected_by: null,
        rejected_at: null,
        rejection_reason: null,
        cancelled_at: null,
        cancellation_reason: null,
      });
      onOpenChange(false);
      resetForm();
    } catch (error) {
      console.error("Error creating leave request:", error);
      toast.error("Failed to create leave request");
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedBalance = leaveTypeId
    ? leaveBalances.find((b) => b.leave_type_id === leaveTypeId)
    : null;

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Request leave"
      description="Submit a new leave request for approval."
      size="lg"
      onSubmit={handleSubmit}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              isSubmitting ||
              !leaveTypeId ||
              !startDate ||
              !endDate ||
              !currentEmployee ||
              insufficientBalance
            }
          >
            {isSubmitting ? "Submitting…" : "Submit request"}
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Leave details" fullWidth>
        <WorkflowSheetGrid>
          <WorkflowField label="Leave type" required htmlFor="leave-type">
            <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
              <SelectTrigger id="leave-type">
                <SelectValue placeholder="Select leave type" />
              </SelectTrigger>
              <SelectContent>
                {leaveTypes.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: type.color || "#3b82f6" }}
                      />
                      {type.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField
            label="Balance"
            hint={
              selectedBalance
                ? `${selectedBalance.available - selectedBalance.pending} day(s) available`
                : "Select a leave type to see balance"
            }
          >
            <div className="h-9 flex items-center text-sm text-muted-foreground">
              {selectedBalance
                ? `${selectedBalance.available - selectedBalance.pending} / ${selectedBalance.available}`
                : "—"}
            </div>
          </WorkflowField>
          <WorkflowField label="Start date" required>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !startDate && "text-muted-foreground",
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {startDate ? format(startDate, "PPP") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={startDate}
                  onSelect={setStartDate}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </WorkflowField>
          <WorkflowField label="End date" required>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !endDate && "text-muted-foreground",
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {endDate ? format(endDate, "PPP") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={endDate}
                  onSelect={setEndDate}
                  disabled={(date) => (startDate ? date < startDate : false)}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </WorkflowField>
        </WorkflowSheetGrid>

        {startDate && endDate && calculatedDays !== null && (
          <div className="space-y-2 pt-1">
            <div className="rounded-lg bg-muted p-3 text-sm">
              <span className="font-medium">{calculatedDays} day(s)</span> requested
              <span className="text-muted-foreground ml-1">
                (excludes weekends &amp; holidays)
              </span>
            </div>
            {insufficientBalance && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Insufficient leave balance. You don't have enough days available
                  for this leave type.
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </WorkflowSheetSection>

      <WorkflowSheetSection number={2} title="Justification" fullWidth>
        <WorkflowField
          label="Reason"
          htmlFor="reason"
          hint="Optional — share context that helps your manager approve quickly."
        >
          <Textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Add a note for your manager…"
            rows={4}
          />
        </WorkflowField>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
