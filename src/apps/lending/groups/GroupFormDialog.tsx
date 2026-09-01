/**
 * Group create/edit dialog (C3).
 *
 * Captures the group identity, owning branch and loan officer, and the weekly
 * meeting slot. Membership is managed separately on the membership roll.
 */

import { useEffect, useState } from "react";
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
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import {
  MEETING_DAYS,
  MF_GROUP_STATUSES,
  nextGroupNumber,
  type MfGroup,
  type MfGroupInput,
  type MfGroupStatus,
} from "@/hooks/useMfGroups";

const UNASSIGNED = "__unassigned__";
const NO_DAY = "__none__";

interface GroupFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: MfGroup | null;
  existingGroups: Array<{ group_number: string }>;
  onCreate: (input: MfGroupInput) => Promise<void>;
  onUpdate: (id: string, patch: Partial<MfGroupInput>) => Promise<void>;
}

interface FormState {
  group_number: string;
  name: string;
  branch_id: string;
  loan_officer_id: string;
  meeting_day: string;
  meeting_time: string;
  meeting_place: string;
  formed_on: string;
  status: MfGroupStatus;
  notes: string;
}

const EMPTY: FormState = {
  group_number: "",
  name: "",
  branch_id: "",
  loan_officer_id: UNASSIGNED,
  meeting_day: NO_DAY,
  meeting_time: "",
  meeting_place: "",
  formed_on: new Date().toISOString().slice(0, 10),
  status: "forming",
  notes: "",
};

export function GroupFormDialog({
  open,
  onOpenChange,
  group,
  existingGroups,
  onCreate,
  onUpdate,
}: GroupFormDialogProps) {
  const { branches } = useBranches();
  const { members } = useOrgMembers();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (group) {
      setForm({
        group_number: group.group_number,
        name: group.name,
        branch_id: group.branch_id,
        loan_officer_id: group.loan_officer_id ?? UNASSIGNED,
        meeting_day: group.meeting_day ? String(group.meeting_day) : NO_DAY,
        meeting_time: group.meeting_time?.slice(0, 5) ?? "",
        meeting_place: group.meeting_place ?? "",
        formed_on: group.formed_on,
        status: group.status,
        notes: group.notes ?? "",
      });
    } else {
      setForm({
        ...EMPTY,
        group_number: nextGroupNumber(existingGroups),
        branch_id: branches[0]?.id ?? "",
      });
    }
  }, [open, group, branches, existingGroups]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const canSave =
    form.name.trim().length > 0 &&
    form.group_number.trim().length > 0 &&
    form.branch_id.length > 0 &&
    !saving;

  const toInput = (): MfGroupInput => ({
    group_number: form.group_number.trim(),
    name: form.name.trim(),
    branch_id: form.branch_id,
    loan_officer_id: form.loan_officer_id === UNASSIGNED ? null : form.loan_officer_id,
    meeting_day: form.meeting_day === NO_DAY ? null : Number(form.meeting_day),
    meeting_time: form.meeting_time ? form.meeting_time : null,
    meeting_place: form.meeting_place.trim() || null,
    formed_on: form.formed_on,
    status: form.status,
    notes: form.notes.trim() || null,
  });

  const submit = async () => {
    setSaving(true);
    try {
      if (group) await onUpdate(group.id, toInput());
      else await onCreate(toInput());
      onOpenChange(false);
    } catch {
      /* hook surfaces the error */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{group ? "Edit group" : "Create group"}</DialogTitle>
          <DialogDescription>
            Groups are a collection structure. Membership never implies joint
            liability — every loan stays individual.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="group_number">Group number</Label>
            <Input
              id="group_number"
              value={form.group_number}
              onChange={(e) => set("group_number", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group_name">Group name</Label>
            <Input
              id="group_name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Branch</Label>
            <Select value={form.branch_id} onValueChange={(v) => set("branch_id", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Loan officer</Label>
            <Select
              value={form.loan_officer_id}
              onValueChange={(v) => set("loan_officer_id", v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name || m.email || m.user_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Meeting day</Label>
            <Select value={form.meeting_day} onValueChange={(v) => set("meeting_day", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DAY}>Not set</SelectItem>
                {MEETING_DAYS.map((d) => (
                  <SelectItem key={d.value} value={String(d.value)}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="meeting_time">Meeting time</Label>
            <Input
              id="meeting_time"
              type="time"
              value={form.meeting_time}
              onChange={(e) => set("meeting_time", e.target.value)}
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="meeting_place">Meeting place</Label>
            <Input
              id="meeting_place"
              value={form.meeting_place}
              onChange={(e) => set("meeting_place", e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="formed_on">Formed on</Label>
            <Input
              id="formed_on"
              type="date"
              value={form.formed_on}
              onChange={(e) => set("formed_on", e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select
              value={form.status}
              onValueChange={(v) => set("status", v as MfGroupStatus)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MF_GROUP_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="group_notes">Notes</Label>
            <Textarea
              id="group_notes"
              rows={3}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={submit}>
            {group ? "Save changes" : "Create group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default GroupFormDialog;
