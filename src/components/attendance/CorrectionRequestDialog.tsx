/**
 * CorrectionRequestDialog — employee requests a time correction.
 *
 * Pass 5 — Attendance: migrated from `Dialog` to `WorkflowSheet` so the
 * presentation matches the New Payroll Run standard. Pure presentation
 * change; the submit payload, validation, and parent wiring are untouched.
 */
import { useState } from "react";
import { format } from "date-fns";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AttendanceRecord } from "@/hooks/useAttendance";

interface Props {
  record: AttendanceRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: {
    newClockIn?: string;
    newClockOut?: string;
    reason: string;
  }) => void;
}

export function CorrectionRequestDialog({
  record,
  open,
  onOpenChange,
  onSubmit,
}: Props) {
  const [clockIn, setClockIn] = useState(
    record.clock_in ? format(new Date(record.clock_in), "HH:mm") : ""
  );
  const [clockOut, setClockOut] = useState(
    record.clock_out ? format(new Date(record.clock_out), "HH:mm") : ""
  );
  const [reason, setReason] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;

    const dateStr = record.attendance_date;
    const data: Parameters<typeof onSubmit>[0] = { reason: reason.trim() };

    if (clockIn) data.newClockIn = `${dateStr}T${clockIn}:00`;
    if (clockOut) data.newClockOut = `${dateStr}T${clockOut}:00`;

    onSubmit(data);
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Request time correction"
      description={format(new Date(record.attendance_date), "EEEE, MMMM d, yyyy")}
      onSubmit={handleSubmit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!reason.trim()}>
            Submit request
          </Button>
        </>
      }
    >
      <WorkflowSheetGrid>
        <WorkflowSheetSection number={1} title="Corrected times" fullWidth>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField
              label="Corrected clock in"
              htmlFor="correction-clock-in"
              hint={
                record.clock_in
                  ? `Original: ${format(new Date(record.clock_in), "hh:mm a")}`
                  : undefined
              }
            >
              <Input
                id="correction-clock-in"
                type="time"
                value={clockIn}
                onChange={(e) => setClockIn(e.target.value)}
              />
            </WorkflowField>
            <WorkflowField
              label="Corrected clock out"
              htmlFor="correction-clock-out"
              hint={
                record.clock_out
                  ? `Original: ${format(new Date(record.clock_out), "hh:mm a")}`
                  : undefined
              }
            >
              <Input
                id="correction-clock-out"
                type="time"
                value={clockOut}
                onChange={(e) => setClockOut(e.target.value)}
              />
            </WorkflowField>
          </div>
        </WorkflowSheetSection>
      </WorkflowSheetGrid>

      <WorkflowSheetSection number={2} title="Justification">
        <WorkflowField label="Reason for correction" htmlFor="correction-reason" required>
          <Textarea
            id="correction-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain why the times need to be corrected…"
            rows={4}
            required
          />
        </WorkflowField>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
