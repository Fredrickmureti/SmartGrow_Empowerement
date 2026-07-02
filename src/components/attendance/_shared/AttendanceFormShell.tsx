/**
 * AttendanceFormShell — thin wrapper around WorkflowSheet so every HR
 * Attendance / Scheduling create/edit experience opens in the same
 * right-side enterprise sheet, sized and titled consistently.
 *
 * Mirrors TalentFormShell / HrConfigFormShell — keeps the chrome
 * recipe in one place so future scheduling editors don't re-derive it.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import {
  WorkflowSheet,
  type WorkflowSheetSize,
} from "@/components/workflow/WorkflowSheet";

export type AttendanceEntity =
  | "shift"
  | "roster-assignment"
  | "manual-attendance"
  | "attendance-edit"
  | "work-schedule"
  | "device"
  | "device-assignment";

const META: Record<
  AttendanceEntity,
  { create: string; edit: string; description: string; size: WorkflowSheetSize }
> = {
  shift: {
    create: "New shift",
    edit: "Edit shift",
    description:
      "A reusable working pattern (start, end, breaks). Assigned to employees through schedules and the roster.",
    size: "lg",
  },
  "roster-assignment": {
    create: "Assign roster",
    edit: "Edit roster assignment",
    description:
      "Place an employee on a shift for a date range. Conflicts with existing assignments are flagged.",
    size: "md",
  },
  "manual-attendance": {
    create: "Manual attendance entry",
    edit: "Edit attendance entry",
    description:
      "Record an attendance event when the device or app didn't capture it. The audit trail records who entered it.",
    size: "md",
  },
  "attendance-edit": {
    create: "Edit attendance record",
    edit: "Edit attendance record",
    description:
      "Adjust check-in/out times for an existing attendance record. All edits are audited.",
    size: "md",
  },
  "work-schedule": {
    create: "New work schedule",
    edit: "Edit work schedule",
    description:
      "A schedule maps shifts to weekdays. Assign it to employees so attendance and leave know their working pattern.",
    size: "lg",
  },
  device: {
    create: "Register device",
    edit: "Edit device",
    description:
      "Register a biometric, RFID, or kiosk device. Devices push punches into Attendance after pairing.",
    size: "lg",
  },
  "device-assignment": {
    create: "Assign device",
    edit: "Edit device assignment",
    description:
      "Bind this device to a branch or location so punches resolve to the right context.",
    size: "md",
  },
};

export interface AttendanceFormShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: AttendanceEntity;
  mode?: "create" | "edit";
  title?: ReactNode;
  description?: ReactNode;
  size?: WorkflowSheetSize;
  busy?: boolean;
  onSubmit?: () => void;
  submitLabel?: ReactNode;
  submitDisabled?: boolean;
  hideFooter?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}

export function AttendanceFormShell({
  open,
  onOpenChange,
  entity,
  mode = "create",
  title,
  description,
  size,
  busy,
  onSubmit,
  submitLabel,
  submitDisabled,
  hideFooter,
  footer,
  children,
}: AttendanceFormShellProps) {
  const meta = META[entity];
  const resolvedTitle = title ?? (mode === "edit" ? meta.edit : meta.create);
  const resolvedDescription = description ?? meta.description;
  const resolvedSize = size ?? meta.size;

  const defaultFooter =
    onSubmit && !hideFooter ? (
      <>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled || busy}>
          {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          {submitLabel ?? (mode === "edit" ? "Save" : "Create")}
        </Button>
      </>
    ) : (
      footer
    );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      title={resolvedTitle}
      description={resolvedDescription}
      size={resolvedSize}
      onSubmit={
        onSubmit
          ? (e) => {
              e.preventDefault();
              if (!submitDisabled && !busy) onSubmit();
            }
          : undefined
      }
      footer={hideFooter ? undefined : defaultFooter}
    >
      {children}
    </WorkflowSheet>
  );
}
