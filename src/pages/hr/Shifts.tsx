/**
 * Shifts admin page (Turn E) — define shift templates used across the roster.
 * Lives at /hr/attendance/shifts.
 */
import { useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AttendanceFormShell } from "@/components/attendance/_shared/AttendanceFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, Pencil, Plus, Clock } from "lucide-react";
import { useShifts, type Shift } from "@/hooks/useShifts";
import { EmptyStateRail } from "@/components/attendance/EmptyStateRail";

export default function ShiftsPage() {
  const { shifts, isLoading, createShift, updateShift, deleteShift } = useShifts();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Shift | null>(null);

  const empty = {
    name: "",
    code: "",
    start_time: "08:00",
    end_time: "17:00",
    break_minutes: 60,
    paid_break: false,
    night_differential_pct: 0,
    color: "#3b82f6",
    is_active: true,
    description: "",
  };
  const [form, setForm] = useState<typeof empty>(empty);

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(s: Shift) {
    setEditing(s);
    setForm({
      name: s.name,
      code: s.code ?? "",
      start_time: s.start_time.slice(0, 5),
      end_time: s.end_time.slice(0, 5),
      break_minutes: s.break_minutes,
      paid_break: s.paid_break,
      night_differential_pct: Number(s.night_differential_pct),
      color: s.color,
      is_active: s.is_active,
      description: s.description ?? "",
    });
    setOpen(true);
  }

  async function submit() {
    const payload = {
      ...form,
      code: form.code || null,
      description: form.description || null,
      crosses_midnight: form.end_time <= form.start_time,
    };
    if (editing) {
      await updateShift.mutateAsync({ id: editing.id, patch: payload as any });
    } else {
      await createShift.mutateAsync(payload as any);
    }
    setOpen(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Clock className="h-6 w-6" /> Shift Templates
          </h1>
          <p className="text-sm text-muted-foreground">
            Define the shift patterns used to build employee rosters.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> New shift
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All shifts</CardTitle>
          <CardDescription>
            Inactive shifts stay on past rosters but cannot be assigned for new dates.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : shifts.length === 0 ? (
            <EmptyStateRail
              icon={Clock}
              headline="No shifts yet"
              steps={[
                "Create a shift template (start time, end time, break).",
                "Assign it to employees from the Roster.",
                "Activate the schedule to start tracking attendance.",
              ]}
              cta={{ label: "Create shift", onClick: () => { setEditing(null); setOpen(true); } }}
            />

          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead>Break</TableHead>
                  <TableHead>Night diff.</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shifts.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-3 w-3 rounded-full"
                          style={{ backgroundColor: s.color }}
                        />
                        <span className="font-medium">{s.name}</span>
                        {s.code && (
                          <span className="text-xs text-muted-foreground">({s.code})</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {s.start_time.slice(0, 5)} – {s.end_time.slice(0, 5)}
                      {s.crosses_midnight && (
                        <span className="ml-1 text-xs text-muted-foreground">(+1d)</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {s.break_minutes}m {s.paid_break ? "(paid)" : ""}
                    </TableCell>
                    <TableCell>{Number(s.night_differential_pct).toFixed(1)}%</TableCell>
                    <TableCell>
                      <span
                        className={
                          s.is_active
                            ? "text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700"
                            : "text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground"
                        }
                      >
                        {s.is_active ? "Active" : "Inactive"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteShift.mutate(s.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AttendanceFormShell
        open={open}
        onOpenChange={setOpen}
        entity="shift"
        mode={editing ? "edit" : "create"}
        busy={createShift.isPending || updateShift.isPending}
        submitDisabled={!form.name || !form.start_time || !form.end_time}
        submitLabel={editing ? "Save changes" : "Create shift"}
        onSubmit={submit}
      >
        <WorkflowSheetSection number={1} title="Identity" subtitle="How this shift appears across the roster and reports.">
          <WorkflowSheetGrid columns={3}>
            <WorkflowField label="Name" required className="lg:col-span-2">
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Morning" />
            </WorkflowField>
            <WorkflowField label="Color">
              <Input type="color" value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} />
            </WorkflowField>
            <WorkflowField label="Code" hint="Optional short tag used on the roster grid.">
              <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="M" />
            </WorkflowField>
            <WorkflowField label="Active" className="lg:col-span-2">
              <label className="flex items-center gap-2 h-9">
                <Switch checked={form.is_active} onCheckedChange={(v) => setForm((f) => ({ ...f, is_active: v }))} />
                <span className="text-sm">Available for new roster assignments</span>
              </label>
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>

        <WorkflowSheetSection number={2} title="Timing" subtitle="Start, end, and break for one occurrence of this shift.">
          <WorkflowSheetGrid>
            <WorkflowField label="Start time" required>
              <Input type="time" value={form.start_time} onChange={(e) => setForm((f) => ({ ...f, start_time: e.target.value }))} />
            </WorkflowField>
            <WorkflowField label="End time" required>
              <Input type="time" value={form.end_time} onChange={(e) => setForm((f) => ({ ...f, end_time: e.target.value }))} />
            </WorkflowField>
            <WorkflowField label="Break (minutes)">
              <Input type="number" min={0} value={form.break_minutes} onChange={(e) => setForm((f) => ({ ...f, break_minutes: Number(e.target.value) }))} />
            </WorkflowField>
            <WorkflowField label="Break is paid">
              <label className="flex items-center gap-2 h-9">
                <Switch checked={form.paid_break} onCheckedChange={(v) => setForm((f) => ({ ...f, paid_break: v }))} />
                <span className="text-sm">Count the break toward paid time</span>
              </label>
            </WorkflowField>
          </WorkflowSheetGrid>
          {form.end_time <= form.start_time && (
            <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">
              End time is on or before start time — this shift will be treated as crossing midnight.
            </p>
          )}
        </WorkflowSheetSection>

        <WorkflowSheetSection number={3} title="Pay & description" subtitle="Optional differentials and notes that appear on the roster grid tooltip.">
          <WorkflowSheetGrid>
            <WorkflowField label="Night differential %" hint="Bonus applied to hours worked between night windows defined by Payroll.">
              <Input type="number" step="0.1" min={0} value={form.night_differential_pct} onChange={(e) => setForm((f) => ({ ...f, night_differential_pct: Number(e.target.value) }))} />
            </WorkflowField>
            <WorkflowField label="Description">
              <Textarea rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="When to use this shift…" />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      </AttendanceFormShell>
    </div>
  );
}
