/**
 * Lending → Meetings.
 *
 * The officer's field day: every group due on the chosen date (from the
 * group's recurring meeting day) together with any meeting already opened for
 * that date. Opening, completing and postponing are server-side business
 * events — this page only surfaces and launches them.
 *
 * The same page serves supervisors: the branch and officer filters, plus the
 * date, answer "what was scheduled, completed, missed today".
 */
import { useMemo, useState } from "react";
import { CalendarDays, PlayCircle, Wallet } from "lucide-react";
import { usePermissions } from "@/hooks/usePermissions";
import {
  PageHeader,
  PageBody,
  Section,
  FilterBar,
  EmptyState,
  LoadingState,
  ErrorState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { useMfGroups, meetingDayLabel, type MfGroup } from "@/hooks/useMfGroups";
import {
  useMfGroupMeetings,
  useMfRepaymentsBridge,
  MEETING_STATUS_LABEL,
  isoWeekday,
  todayIso,
  type MfGroupMeeting,
  type MfMeetingStatus,
} from "@/hooks/useMfMeetings";
import { useMfRepayments } from "@/hooks/useMfRepayments";
import { MeetingWorkspaceDialog } from "./MeetingWorkspaceDialog";
import { GroupSheetDialog } from "../repayments/GroupSheetDialog";

const STATUS_TONE: Record<MfMeetingStatus, "neutral" | "success" | "warning" | "danger"> = {
  scheduled: "neutral",
  in_progress: "warning",
  completed: "success",
  postponed: "warning",
  missed: "danger",
};

interface Row {
  group: MfGroup;
  meeting: MfGroupMeeting | null;
}

export function MeetingsPage() {
  const { can } = usePermissions();
  const canManage = can("recordRepayments");
  const { branches } = useBranches();
  const { getUserName } = useOrgMembers();

  const [date, setDate] = useState(todayIso());
  const [branchId, setBranchId] = useState<string>("all");
  const [officerId, setOfficerId] = useState<string>("all");

  const { groups, isLoading: groupsLoading, error: groupsError } = useMfGroups({
    branchId: branchId === "all" ? null : branchId,
  });
  const {
    meetings,
    isLoading: meetingsLoading,
    error: meetingsError,
    openMeeting,
  } = useMfGroupMeetings({ from: date, to: date });

  const { openBatch, record } = useMfRepayments();

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [sheetGroupId, setSheetGroupId] = useState<string | null>(null);
  const [sheetMeetingId, setSheetMeetingId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const weekday = isoWeekday(date);

  const rows: Row[] = useMemo(() => {
    const byGroup = new Map(meetings.map((m) => [m.group_id, m]));
    return groups
      .filter((g) => {
        if (officerId !== "all" && g.loan_officer_id !== officerId) return false;
        if (byGroup.has(g.id)) return true;
        return g.status === "active" && g.meeting_day === weekday;
      })
      .map((g) => ({ group: g, meeting: byGroup.get(g.id) ?? null }))
      .sort((a, b) => {
        const at = a.meeting?.scheduled_time ?? a.group.meeting_time ?? "";
        const bt = b.meeting?.scheduled_time ?? b.group.meeting_time ?? "";
        return at.localeCompare(bt) || a.group.name.localeCompare(b.group.name);
      });
  }, [groups, meetings, officerId, weekday]);

  const activeRow = rows.find((r) => r.group.id === activeGroupId) ?? null;
  const activeMeeting = activeRow?.meeting ?? null;

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? "—";

  const start = async (row: Row) => {
    setActiveGroupId(row.group.id);
    if (row.meeting) {
      setWorkspaceOpen(true);
      return;
    }
    await openMeeting.mutateAsync({ groupId: row.group.id, meetingOn: date });
    setWorkspaceOpen(true);
  };

  const collect = (row: Row) => {
    setSheetGroupId(row.group.id);
    setSheetMeetingId(row.meeting?.id ?? null);
    setSheetOpen(true);
  };

  const isLoading = groupsLoading || meetingsLoading;
  const error = (groupsError ?? meetingsError) as Error | null;

  const completed = rows.filter((r) => r.meeting?.status === "completed").length;
  const outstanding = rows.length - completed;

  return (
    <>
      <PageHeader
        eyebrow="Lending"
        title="Meetings"
        description="Group meetings due on this date, what has been completed and what is still outstanding."
      />
      <PageBody>
        <Section
          title={`${rows.length} meeting(s) · ${completed} completed · ${outstanding} outstanding`}
          description={`Groups meeting on ${meetingDayLabel(weekday)}, ${date}.`}
        >
          <FilterBar>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value || todayIso())}
              className="w-[170px]"
            />
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={officerId} onValueChange={setOfficerId}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="All loan officers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All loan officers</SelectItem>
                {Array.from(
                  new Set(
                    groups
                      .map((g) => g.loan_officer_id)
                      .filter((v): v is string => !!v),
                  ),
                ).map((id) => (
                  <SelectItem key={id} value={id}>
                    {getUserName(id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterBar>

          {error ? (
            <ErrorState description={error.message} />
          ) : isLoading ? (
            <LoadingState />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="No meetings on this date"
              description="No active group has this weekday as its regular meeting day, and no meeting was opened for this date."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Group</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Loan officer</TableHead>
                  <TableHead>Time &amp; place</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Next meeting</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ group, meeting }) => (
                  <TableRow key={group.id}>
                    <TableCell className="font-medium">
                      {group.group_number} — {group.name}
                    </TableCell>
                    <TableCell>{branchName(group.branch_id)}</TableCell>
                    <TableCell>
                      {group.loan_officer_id ? getUserName(group.loan_officer_id) : "—"}
                    </TableCell>
                    <TableCell>
                      {(meeting?.scheduled_time ?? group.meeting_time)?.slice(0, 5) ?? "—"}
                      {meeting?.meeting_place || group.meeting_place
                        ? ` · ${meeting?.meeting_place ?? group.meeting_place}`
                        : ""}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={meeting ? STATUS_TONE[meeting.status] : "neutral"}>
                        {meeting ? MEETING_STATUS_LABEL[meeting.status] : "Not opened"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>{meeting?.next_scheduled_on ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-2">
                        {canManage && (
                          <Button size="sm" variant="outline" onClick={() => collect({ group, meeting })}>
                            <Wallet className="mr-1.5 h-4 w-4" />
                            Collections
                          </Button>
                        )}
                        <Button
                          size="sm"
                          onClick={() => start({ group, meeting })}
                          disabled={!canManage && !meeting}
                        >
                          <PlayCircle className="mr-1.5 h-4 w-4" />
                          {meeting ? "Open meeting" : "Start meeting"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      {activeMeeting && (
        <MeetingWorkspaceDialog
          open={workspaceOpen}
          onOpenChange={setWorkspaceOpen}
          meeting={activeMeeting}
          group={activeRow?.group ?? null}
          canManage={canManage}
          onCollect={() => {
            setWorkspaceOpen(false);
            if (activeRow) collect(activeRow);
          }}
        />
      )}

      <GroupSheetDialog
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        lockedGroupId={sheetGroupId}
        meetingId={sheetMeetingId}
        defaultDate={date}
        onOpenBatch={(input) => openBatch.mutateAsync(input)}
        onRecord={(input) => record.mutateAsync(input)}
      />
    </>
  );
}

export default MeetingsPage;
