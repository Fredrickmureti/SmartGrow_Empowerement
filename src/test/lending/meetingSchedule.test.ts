/**
 * Business-event tests for the field meeting day list.
 *
 * These cover the only meeting logic that lives on the client: which groups are
 * due on a given date. Lifecycle rules (completion, duplicate completion, next
 * meeting date, cross-branch refusal) are enforced by the database RPCs and
 * triggers `mf_open_group_meeting`, `mf_complete_group_meeting`,
 * `mf_postpone_group_meeting`, `_mf_group_meeting_scope_guard`,
 * `_mf_meeting_attendance_guard` and `_mf_meeting_link_guard`.
 */
import { describe, expect, it } from "vitest";
import {
  isoWeekdayOf,
  meetingRowsForDate,
  meetingTimesError,
  type MeetingScheduleGroup,
} from "@/lib/lending/meetingSchedule";

const group = (over: Partial<MeetingScheduleGroup> = {}): MeetingScheduleGroup => ({
  id: "g1",
  name: "Alpha",
  status: "active",
  meeting_day: 3,
  meeting_time: "09:00:00",
  loan_officer_id: "officer-1",
  ...over,
});

// 2026-09-09 is a Wednesday (ISO weekday 3).
const WED = "2026-09-09";
const THU = "2026-09-10";

describe("isoWeekdayOf", () => {
  it("returns Monday as 1 and Sunday as 7", () => {
    expect(isoWeekdayOf("2026-09-07")).toBe(1);
    expect(isoWeekdayOf(WED)).toBe(3);
    expect(isoWeekdayOf("2026-09-13")).toBe(7);
  });
});

describe("meetingRowsForDate", () => {
  it("lists an active group whose recurring day falls on the date", () => {
    const rows = meetingRowsForDate([group()], [], WED);
    expect(rows).toHaveLength(1);
    expect(rows[0].meeting).toBeNull();
  });

  it("omits the group on a day it does not meet", () => {
    expect(meetingRowsForDate([group()], [], THU)).toHaveLength(0);
  });

  it("omits groups that are not active", () => {
    expect(meetingRowsForDate([group({ status: "dormant" })], [], WED)).toHaveLength(0);
  });

  it("still lists a group when a meeting exists on a non-recurring date", () => {
    const rows = meetingRowsForDate(
      [group({ status: "dormant" })],
      [{ group_id: "g1", scheduled_time: "10:00:00" }],
      THU,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].meeting).not.toBeNull();
  });

  it("attaches the meeting record to its group without duplicating the row", () => {
    const rows = meetingRowsForDate(
      [group()],
      [{ group_id: "g1", scheduled_time: "09:00:00" }],
      WED,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].meeting?.group_id).toBe("g1");
  });

  it("scopes the list to one loan officer when asked", () => {
    const rows = meetingRowsForDate(
      [group(), group({ id: "g2", name: "Beta", loan_officer_id: "officer-2" })],
      [],
      WED,
      "officer-2",
    );
    expect(rows.map((r) => r.group.id)).toEqual(["g2"]);
  });

  it("orders the day by meeting time, then name", () => {
    const rows = meetingRowsForDate(
      [
        group({ id: "b", name: "Beta", meeting_time: "11:00:00" }),
        group({ id: "a", name: "Alpha", meeting_time: "08:00:00" }),
        group({ id: "c", name: "Gamma", meeting_time: "08:00:00" }),
      ],
      [],
      WED,
    );
    expect(rows.map((r) => r.group.id)).toEqual(["a", "c", "b"]);
  });

  it("returns nothing when no group has a recurring rule for the date", () => {
    expect(meetingRowsForDate([group({ meeting_day: null })], [], WED)).toHaveLength(0);
  });
});

describe("meetingTimesError", () => {
  it("asks for the end time when it is missing", () => {
    expect(meetingTimesError("09:00", "")).toBe("Enter the time the meeting ended.");
  });

  it("asks for the start time when it is missing", () => {
    expect(meetingTimesError("", "12:00")).toBe("Enter the time the meeting started.");
  });

  it("refuses an end time that is not after the start time", () => {
    expect(meetingTimesError("12:00", "09:00")).toBe(
      "The end time must be after the start time.",
    );
    expect(meetingTimesError("09:00", "09:00")).not.toBeNull();
  });

  it("accepts a meeting that ran 09:00 to 12:00", () => {
    expect(meetingTimesError("09:00", "12:00")).toBeNull();
  });
});
