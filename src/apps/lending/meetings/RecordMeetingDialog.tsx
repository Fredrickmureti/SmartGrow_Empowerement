/**
 * Record a meeting held on any date.
 *
 * The Meetings list only shows a group on its recurring weekday. A meeting held
 * off-schedule, or written up after the fact from the officer's paper notes,
 * has no row to click — this dialog is that path. It only calls the
 * authoritative `mf_open_group_meeting` RPC; every scope rule stays in the
 * database (an officer limited to their own portfolio cannot name someone else
 * as the one who held it).
 */
import { useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { meetingDayLabel, type MfGroup } from "@/hooks/useMfGroups";
import { todayIso } from "@/hooks/useMfMeetings";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: MfGroup[];
  defaultDate: string;
  isSaving: boolean;
  onRecord: (input: {
    groupId: string;
    meetingOn: string;
    startedAtTime: string | null;
    heldBy: string | null;
  }) => Promise<void>;
}

const SELF = "self";

export function RecordMeetingDialog({
  open,
  onOpenChange,
  groups,
  defaultDate,
  isSaving,
  onRecord,
}: Props) {
  const { members } = useOrgMembers();
  const [groupId, setGroupId] = useState<string>("");
  const [meetingOn, setMeetingOn] = useState(defaultDate);
  const [startedAt, setStartedAt] = useState("");
  const [heldBy, setHeldBy] = useState<string>(SELF);

  const selectable = useMemo(
    () => groups.filter((g) => g.status !== "closed"),
    [groups],
  );
  const group = selectable.find((g) => g.id === groupId) ?? null;

  // Picking the group offers its usual meeting time as the starting point; the
  // officer overwrites it with the time the meeting really started.
  const chooseGroup = (id: string) => {
    setGroupId(id);
    const g = selectable.find((x) => x.id === id);
    if (g?.meeting_time && !startedAt) setStartedAt(g.meeting_time.slice(0, 5));
    if (g?.loan_officer_id) setHeldBy(g.loan_officer_id);
  };

  const future = meetingOn > todayIso();
  const canSave = !!groupId && !!meetingOn && !future && !isSaving;

  const submit = async () => {
    if (!canSave) return;
    await onRecord({
      groupId,
      meetingOn,
      startedAtTime: startedAt || null,
      heldBy: heldBy === SELF ? null : heldBy,
    });
    setGroupId("");
    setStartedAt("");
    setHeldBy(SELF);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a meeting</DialogTitle>
          <DialogDescription>
            For a meeting held on a day other than the group's usual one, or one being
            written up afterwards from the field notes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Group</Label>
            <Select value={groupId} onValueChange={chooseGroup}>
              <SelectTrigger>
                <SelectValue placeholder="Choose the group that met" />
              </SelectTrigger>
              <SelectContent>
                {selectable.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.group_number} — {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {group && (
              <p className="text-xs text-muted-foreground">
                Usually meets on {meetingDayLabel(group.meeting_day)}
                {group.meeting_time ? ` at ${group.meeting_time.slice(0, 5)}` : ""}.
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="record-date">Date the meeting was held</Label>
              <Input
                id="record-date"
                type="date"
                value={meetingOn}
                max={todayIso()}
                onChange={(e) => setMeetingOn(e.target.value)}
              />
              {future && (
                <p className="text-xs text-destructive">
                  A meeting cannot be recorded for a future date.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="record-start">Started at</Label>
              <Input
                id="record-start"
                type="time"
                value={startedAt}
                onChange={(e) => setStartedAt(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The end time is entered when you complete the meeting.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Held by</Label>
            <Select value={heldBy} onValueChange={setHeldBy}>
              <SelectTrigger>
                <SelectValue placeholder="Who held the meeting" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELF}>Me</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name || m.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Choose the loan officer who actually conducted it. Your name is kept
              separately as the person who entered the record.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={submit}>
            {isSaving ? "Opening…" : "Open the meeting"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
