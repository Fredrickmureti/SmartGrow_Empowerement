/**
 * Meeting workspace — the officer's one place to run today's group meeting.
 *
 * Attendance, notes and completion all act on the authoritative meeting record
 * through the server RPCs. Money is still captured by the existing group
 * collection sheet, now stamped with this meeting.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { meetingTimesError } from "@/lib/lending/meetingSchedule";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, LoadingState, StatusBadge } from "@/design-system";
import { useMfClients } from "@/hooks/useMfClients";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { useMfGroupMembers, type MfGroup } from "@/hooks/useMfGroups";
import { ClientFormDialog } from "../clients/ClientFormDialog";
import {
  useMfGroupMeetings,
  useMfMeetingAttendance,
  useMfMeetingSummary,
  MEETING_STATUS_LABEL,
  type MfAttendanceStatus,
  type MfGroupMeeting,
} from "@/hooks/useMfMeetings";

const ATTENDANCE_OPTIONS: { value: MfAttendanceStatus; label: string }[] = [
  { value: "present", label: "Present" },
  { value: "absent", label: "Absent" },
  { value: "excused", label: "Excused" },
];

/** "09:00:00" → "09:00"; null → "". */
function hhmm(value: string | null | undefined): string {
  return value ? value.slice(0, 5) : "";
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meeting: MfGroupMeeting;
  group: MfGroup | null;
  canManage: boolean;
  onCollect?: () => void;
}

export function MeetingWorkspaceDialog({
  open,
  onOpenChange,
  meeting,
  group,
  canManage,
  onCollect,
}: Props) {
  const { members, isLoading } = useMfGroupMembers(open ? meeting.group_id : null);
  const { clients, createClient, updateClient } = useMfClients();
  const { attendance, setAttendance } = useMfMeetingAttendance(open ? meeting.id : null);
  const { summary } = useMfMeetingSummary(open ? meeting.id : null);
  const { completeMeeting, postponeMeeting } = useMfGroupMeetings({
    from: meeting.scheduled_on,
    to: meeting.scheduled_on,
  });

  const queryClient = useQueryClient();
  const { getUserName, members: orgMembers } = useOrgMembers();
  const [notes, setNotes] = useState(meeting.notes ?? "");
  const [newDate, setNewDate] = useState("");
  const [registering, setRegistering] = useState(false);
  const [startedAt, setStartedAt] = useState(
    hhmm(meeting.started_at_time ?? meeting.scheduled_time),
  );
  const [endedAt, setEndedAt] = useState(hhmm(meeting.ended_at_time));
  const [heldBy, setHeldBy] = useState<string>(
    meeting.held_by ?? meeting.loan_officer_id ?? "",
  );
  const timesError = meetingTimesError(startedAt, endedAt);

  const clientLabel = useMemo(() => {
    const map = new Map(clients.map((c) => [c.id, `${c.client_number} — ${c.full_name}`]));
    return (id: string) => map.get(id) ?? "—";
  }, [clients]);

  const attendanceOf = useMemo(() => {
    const map = new Map(attendance.map((a) => [a.client_id, a.status]));
    return (clientId: string) => map.get(clientId) ?? null;
  }, [attendance]);

  const activeMembers = members.filter((m) => m.is_active);
  const isOpenForWork = meeting.status === "in_progress" || meeting.status === "scheduled";
  const presentCount = attendance.filter((a) => a.status === "present").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {group ? `${group.group_number} — ${group.name}` : "Group meeting"}
          </DialogTitle>
          <DialogDescription>
            Meeting of {meeting.scheduled_on}
            {meeting.scheduled_time ? ` at ${meeting.scheduled_time.slice(0, 5)}` : ""}
            {meeting.meeting_place ? ` · ${meeting.meeting_place}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge tone={meeting.status === "completed" ? "success" : "neutral"}>
            {MEETING_STATUS_LABEL[meeting.status]}
          </StatusBadge>
          <span className="text-muted-foreground">
            {presentCount} of {activeMembers.length} member(s) marked present
          </span>
          {meeting.status === "completed" && (
            <span className="text-muted-foreground">
              Ran {hhmm(meeting.started_at_time) || "—"} to{" "}
              {hhmm(meeting.ended_at_time) || "—"}
            </span>
          )}
          <span className="text-muted-foreground">
            Held by {getUserName(meeting.held_by ?? meeting.loan_officer_id ?? "")}
            {meeting.recorded_by && meeting.recorded_by !== (meeting.held_by ?? meeting.loan_officer_id)
              ? ` · recorded by ${getUserName(meeting.recorded_by)}`
              : ""}
          </span>
          {meeting.next_scheduled_on && (
            <span className="text-muted-foreground">
              Next meeting: {meeting.next_scheduled_on}
            </span>
          )}
        </div>

        <div className="max-h-[40vh] overflow-y-auto">
          {isLoading ? (
            <LoadingState />
          ) : activeMembers.length === 0 ? (
            <EmptyState
              title="No active members"
              description="Add members to this group before recording attendance."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead className="text-right">Attendance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeMembers.map((m) => {
                  const current = attendanceOf(m.client_id);
                  return (
                    <TableRow key={m.id}>
                      <TableCell>{clientLabel(m.client_id)}</TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex gap-1">
                          {ATTENDANCE_OPTIONS.map((opt) => (
                            <Button
                              key={opt.value}
                              size="sm"
                              variant={current === opt.value ? "default" : "outline"}
                              disabled={!canManage || !isOpenForWork}
                              onClick={() =>
                                setAttendance.mutate({
                                  clientId: m.client_id,
                                  status: opt.value,
                                })
                              }
                            >
                              {opt.label}
                            </Button>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">What happened at this meeting</p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            <li>
              {presentCount} present, {activeMembers.length - presentCount} not marked
              present, of {activeMembers.length} member(s)
            </li>
            <li>
              {summary?.receiptCount ?? 0} payment(s) collected
              {summary && summary.collectedTotal > 0
                ? ` — KES ${summary.collectedTotal.toLocaleString()}`
                : ""}
            </li>
            <li>
              {summary && summary.onboarded.length > 0
                ? `Joined here: ${summary.onboarded
                    .map((c) => `${c.full_name} (${c.client_number})`)
                    .join(", ")}`
                : "No new client registered at this meeting"}
            </li>
          </ul>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="meeting-started">Meeting started at</Label>
            <Input
              id="meeting-started"
              type="time"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
              disabled={!canManage || !isOpenForWork}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meeting-ended">Meeting ended at</Label>
            <Input
              id="meeting-ended"
              type="time"
              value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
              disabled={!canManage || !isOpenForWork}
            />
            <p className="text-xs text-muted-foreground">
              Required to complete the meeting. Type the time it actually ended.
            </p>
          </div>
          {isOpenForWork && canManage && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Held by</Label>
              <Select value={heldBy} onValueChange={setHeldBy}>
                <SelectTrigger>
                  <SelectValue placeholder="Who held this meeting" />
                </SelectTrigger>
                <SelectContent>
                  {orgMembers.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name || m.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The loan officer who actually conducted it. Your name is kept separately
                as the person who entered the record.
              </p>
            </div>
          )}
          {isOpenForWork && canManage && timesError && (
            <p className="text-xs text-destructive sm:col-span-2">{timesError}</p>
          )}
        </div>


        <div className="space-y-1.5">
          <Label>Meeting notes and pending items</Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={!canManage || !isOpenForWork}
            placeholder="What was accomplished, what remains pending…"
            rows={3}
          />
        </div>

        {isOpenForWork && canManage && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Postpone to (optional)</Label>
              <Input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty and use “Record as missed” if the meeting did not happen.
              </p>
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {onCollect && isOpenForWork && (
              <Button variant="outline" onClick={onCollect}>
                Record collections
              </Button>
            )}
            {isOpenForWork && canManage && (
              <Button variant="outline" onClick={() => setRegistering(true)}>
                Register a client here
              </Button>
            )}
            {isOpenForWork && canManage && (
              <>
                <Button
                  variant="outline"
                  disabled={!newDate || postponeMeeting.isPending}
                  onClick={() =>
                    postponeMeeting.mutate(
                      { meetingId: meeting.id, newDate, reason: notes || null },
                      { onSuccess: () => onOpenChange(false) },
                    )
                  }
                >
                  Postpone
                </Button>
                <Button
                  variant="outline"
                  disabled={postponeMeeting.isPending}
                  onClick={() =>
                    postponeMeeting.mutate(
                      { meetingId: meeting.id, newDate: null, reason: notes || null },
                      { onSuccess: () => onOpenChange(false) },
                    )
                  }
                >
                  Record as missed
                </Button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {isOpenForWork && canManage && (
              <Button
                disabled={completeMeeting.isPending || !!timesError}
                onClick={() =>
                  completeMeeting.mutate(
                    {
                      meetingId: meeting.id,
                      notes: notes || null,
                      startedAtTime: startedAt || null,
                      endedAtTime: endedAt || null,
                      heldBy: heldBy || null,
                    },
                    { onSuccess: () => onOpenChange(false) },
                  )
                }
              >
                {completeMeeting.isPending ? "Completing…" : "Complete meeting"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>

      <ClientFormDialog
        open={registering}
        onOpenChange={(o) => {
          if (!o) setRegistering(false);
        }}
        client={null}
        meetingContext={{ meetingId: meeting.id, groupId: meeting.group_id }}
        onCreate={async (input) => {
          const created = await createClient.mutateAsync(input);
          queryClient.invalidateQueries({ queryKey: ["mf-meeting-summary"] });
          return created;
        }}
        onUpdate={async (id, patch) => {
          await updateClient.mutateAsync({ id, ...patch });
        }}
      />
    </Dialog>
  );
}
