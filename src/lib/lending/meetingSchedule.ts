/**
 * Meeting scheduling rules that the client is allowed to know.
 *
 * The authoritative lifecycle (open / complete / postpone / next date) lives in
 * the database RPCs. This module only derives *which groups are due* on a date
 * from the group's recurring meeting day, so the officer's day can be listed
 * before any meeting record exists. It never decides an outcome.
 */

export interface MeetingScheduleGroup {
  id: string;
  name: string;
  status: string;
  meeting_day: number | null;
  meeting_time: string | null;
  loan_officer_id: string | null;
}

export interface MeetingScheduleMeeting {
  group_id: string;
  scheduled_time: string | null;
}

/** ISO weekday (1 = Monday … 7 = Sunday) for a yyyy-mm-dd date string. */
export function isoWeekdayOf(date: string): number {
  const d = new Date(`${date}T00:00:00`);
  return d.getDay() === 0 ? 7 : d.getDay();
}

/**
 * Groups to show for a date: every group that already has a meeting record on
 * that date, plus every active group whose recurring day falls on it.
 * Ordered by meeting time, then group name.
 */
export function meetingRowsForDate<
  G extends MeetingScheduleGroup,
  M extends MeetingScheduleMeeting,
>(
  groups: G[],
  meetings: M[],
  date: string,
  officerId?: string | null,
): Array<{ group: G; meeting: M | null }> {
  const weekday = isoWeekdayOf(date);
  const byGroup = new Map(meetings.map((m) => [m.group_id, m]));

  return groups
    .filter((g) => {
      if (officerId && g.loan_officer_id !== officerId) return false;
      if (byGroup.has(g.id)) return true;
      return g.status === "active" && g.meeting_day === weekday;
    })
    .map((g) => ({ group: g, meeting: byGroup.get(g.id) ?? null }))
    .sort((a, b) => {
      const at = a.meeting?.scheduled_time ?? a.group.meeting_time ?? "";
      const bt = b.meeting?.scheduled_time ?? b.group.meeting_time ?? "";
      return at.localeCompare(bt) || a.group.name.localeCompare(b.group.name);
    });
}
