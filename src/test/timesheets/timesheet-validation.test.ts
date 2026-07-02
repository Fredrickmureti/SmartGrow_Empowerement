/**
 * Timesheet validation logic tests.
 *
 * These tests verify the client-side validation rules that mirror
 * the server-side triggers, ensuring impossible states are blocked
 * before hitting the API.
 */
import { describe, it, expect } from "vitest";

// --- Pure validation helpers extracted from TimesheetEntryForm logic ---

function getBillableDisabledReason(
  project: { is_billable?: boolean; hourly_rate?: number | null } | null,
): string | null {
  if (!project) return "Pick a billable project to mark this entry as billable.";
  if (!project.is_billable) return "This project is non-billable.";
  if (!project.hourly_rate || project.hourly_rate <= 0)
    return "This project has no billing rate configured.";
  return null;
}

interface ValidationInput {
  date: Date | undefined;
  hours: string;
  projectId: string;
  taskId: string;
  isBillable: boolean;
  billableDisabledReason: string | null;
  timeOffOverlap: boolean;
  sameDayHours: number;
  settings: {
    require_project?: boolean;
    require_task?: boolean;
    minimum_hours_per_day?: number | null;
    maximum_hours_per_day?: number | null;
  } | null;
}

const NONE = "__none__";

function validate(input: ValidationInput): string | null {
  const { date, hours, projectId, taskId, isBillable, billableDisabledReason, timeOffOverlap, sameDayHours, settings } = input;
  if (!date) return "Pick a date.";
  if (!hours) return "Enter hours.";
  const n = parseFloat(hours);
  if (!Number.isFinite(n) || n <= 0) return "Hours must be positive.";
  if (settings?.require_project && projectId === NONE) return "A project is required by your org settings.";
  if (settings?.require_task && taskId === NONE) return "A task is required by your org settings.";
  const maxH = settings?.maximum_hours_per_day ?? null;
  const dayTotal = sameDayHours + n;
  if (maxH != null && dayTotal > maxH)
    return `Day would total ${dayTotal}h — exceeds the ${maxH}h daily maximum.`;
  if (isBillable && billableDisabledReason)
    return `Cannot mark billable: ${billableDisabledReason}`;
  if (timeOffOverlap)
    return "You have approved time off on this date — entry blocked by org settings.";
  return null;
}

describe("Timesheet billable disabled reason", () => {
  it("returns reason when no project selected", () => {
    expect(getBillableDisabledReason(null)).toContain("Pick a billable project");
  });

  it("returns reason when project is non-billable", () => {
    expect(getBillableDisabledReason({ is_billable: false, hourly_rate: 50 })).toContain("non-billable");
  });

  it("returns reason when project has no rate", () => {
    expect(getBillableDisabledReason({ is_billable: true, hourly_rate: 0 })).toContain("no billing rate");
  });

  it("returns null when project is billable with rate", () => {
    expect(getBillableDisabledReason({ is_billable: true, hourly_rate: 100 })).toBeNull();
  });
});

describe("Timesheet entry validation", () => {
  const base: ValidationInput = {
    date: new Date(),
    hours: "4",
    projectId: "proj-1",
    taskId: NONE,
    isBillable: false,
    billableDisabledReason: null,
    timeOffOverlap: false,
    sameDayHours: 0,
    settings: null,
  };

  it("passes with valid minimal input", () => {
    expect(validate(base)).toBeNull();
  });

  it("fails when no date", () => {
    expect(validate({ ...base, date: undefined })).toBe("Pick a date.");
  });

  it("fails when hours are zero", () => {
    expect(validate({ ...base, hours: "0" })).toBe("Hours must be positive.");
  });

  it("fails when hours are negative", () => {
    expect(validate({ ...base, hours: "-2" })).toBe("Hours must be positive.");
  });

  it("fails when project required but not selected", () => {
    expect(validate({
      ...base,
      projectId: NONE,
      settings: { require_project: true },
    })).toContain("project is required");
  });

  it("fails when task required but not selected", () => {
    expect(validate({
      ...base,
      settings: { require_task: true },
    })).toContain("task is required");
  });

  it("fails when daily max exceeded", () => {
    const result = validate({
      ...base,
      hours: "6",
      sameDayHours: 5,
      settings: { maximum_hours_per_day: 10 },
    });
    expect(result).toContain("exceeds the 10h daily maximum");
  });

  it("passes when within daily max", () => {
    expect(validate({
      ...base,
      hours: "4",
      sameDayHours: 5,
      settings: { maximum_hours_per_day: 10 },
    })).toBeNull();
  });

  it("fails when billable but project disallows it", () => {
    expect(validate({
      ...base,
      isBillable: true,
      billableDisabledReason: "This project is non-billable.",
    })).toContain("Cannot mark billable");
  });

  it("fails when time-off overlap blocks entry", () => {
    expect(validate({
      ...base,
      timeOffOverlap: true,
    })).toContain("approved time off");
  });
});
