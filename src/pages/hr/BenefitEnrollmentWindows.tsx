/**
 * Benefit Enrollment Windows admin (Turn F).
 * Lives at /hr/benefit-windows. Gates `employee_benefits` mutations via the
 * `block_locked_enrollment_window` trigger.
 */
import { useState } from "react";
import { useBenefitWindows, type BenefitWindow } from "@/hooks/useBenefitWindows";
import {
  Card, CardHeader, CardTitle, CardContent, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { WorkflowSheet, WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Badge } from "@/components/ui/badge";
import { CalendarRange, Lock, Pencil, Plus, Trash2 } from "lucide-react";

export default function BenefitEnrollmentWindowsPage() {
  const { windows, isLoading, createWindow, updateWindow, deleteWindow } = useBenefitWindows();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<BenefitWindow | null>(null);

  const empty = {
    name: "",
    plan_year: new Date().getFullYear() + 1,
    open_date: "",
    close_date: "",
    coverage_start: "",
    coverage_end: "",
    is_locked: false,
    notes: "",
    eligibility_filter: "{}",
  };
  const [form, setForm] = useState<typeof empty>(empty);

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(w: BenefitWindow) {
    setEditing(w);
    setForm({
      name: w.name,
      plan_year: w.plan_year,
      open_date: w.open_date,
      close_date: w.close_date,
      coverage_start: w.coverage_start,
      coverage_end: w.coverage_end,
      is_locked: w.is_locked,
      notes: w.notes ?? "",
      eligibility_filter: JSON.stringify(w.eligibility_filter ?? {}, null, 2),
    });
    setOpen(true);
  }

  async function submit() {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(form.eligibility_filter || "{}");
    } catch {
      alert("Eligibility filter must be valid JSON");
      return;
    }
    const patch = {
      name: form.name,
      plan_year: Number(form.plan_year),
      open_date: form.open_date,
      close_date: form.close_date,
      coverage_start: form.coverage_start,
      coverage_end: form.coverage_end,
      is_locked: form.is_locked,
      notes: form.notes || null,
      eligibility_filter: parsed,
    };
    if (editing) {
      await updateWindow.mutateAsync({ id: editing.id, patch: patch as any });
    } else {
      await createWindow.mutateAsync(patch as any);
    }
    setOpen(false);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><CalendarRange className="h-5 w-5" /> Benefit Enrollment Windows</CardTitle>
            <CardDescription>
              Define open-enrollment periods. Locked windows block further changes to employee_benefits inside them.
            </CardDescription>
          </div>
          <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> New Window</Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : windows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No enrollment windows yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Plan Year</TableHead>
                  <TableHead>Open</TableHead>
                  <TableHead>Close</TableHead>
                  <TableHead>Coverage</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {windows.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">{w.name}</TableCell>
                    <TableCell>{w.plan_year}</TableCell>
                    <TableCell className="text-xs">{w.open_date}</TableCell>
                    <TableCell className="text-xs">{w.close_date}</TableCell>
                    <TableCell className="text-xs">{w.coverage_start} → {w.coverage_end}</TableCell>
                    <TableCell>
                      {w.is_locked ? (
                        <Badge variant="secondary" className="gap-1"><Lock className="h-3 w-3" /> Locked</Badge>
                      ) : (
                        <Badge>Open</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(w)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { if (confirm("Delete this window?")) deleteWindow.mutate(w.id); }}
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

      <WorkflowSheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit Enrollment Window" : "New Enrollment Window"}
        description="Open-enrollment period. Locked windows block changes to employee_benefits in range."
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              onClick={submit}
              disabled={!form.name || !form.open_date || !form.close_date || !form.coverage_start || !form.coverage_end}
            >{editing ? "Save" : "Create"}</Button>
          </>
        }
      >
        <WorkflowSheetGrid>
          <WorkflowSheetSection number={1} title="Identity">
            <WorkflowField label="Name" required>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. 2027 Open Enrollment" />
            </WorkflowField>
            <div className="grid grid-cols-2 gap-3">
              <WorkflowField label="Plan year">
                <Input type="number" value={form.plan_year} onChange={(e) => setForm({ ...form, plan_year: Number(e.target.value) as any })} />
              </WorkflowField>
              <div className="flex items-center gap-2 mt-7">
                <Switch checked={form.is_locked} onCheckedChange={(v) => setForm({ ...form, is_locked: v })} />
                <Label>Locked</Label>
              </div>
            </div>
          </WorkflowSheetSection>
          <WorkflowSheetSection number={2} title="Window dates">
            <div className="grid grid-cols-2 gap-3">
              <WorkflowField label="Open date" required>
                <Input type="date" value={form.open_date} onChange={(e) => setForm({ ...form, open_date: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Close date" required>
                <Input type="date" value={form.close_date} onChange={(e) => setForm({ ...form, close_date: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Coverage start" required>
                <Input type="date" value={form.coverage_start} onChange={(e) => setForm({ ...form, coverage_start: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Coverage end" required>
                <Input type="date" value={form.coverage_end} onChange={(e) => setForm({ ...form, coverage_end: e.target.value })} />
              </WorkflowField>
            </div>
          </WorkflowSheetSection>
        </WorkflowSheetGrid>
        <WorkflowSheetSection number={3} title="Eligibility & notes" fullWidth>
          <WorkflowField label="Eligibility filter (JSON)">
            <Textarea
              rows={4}
              value={form.eligibility_filter}
              onChange={(e) => setForm({ ...form, eligibility_filter: e.target.value })}
              placeholder='{"employment_type":"full_time","min_tenure_months":3}'
              className="font-mono text-xs"
            />
          </WorkflowField>
          <WorkflowField label="Notes">
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheet>
    </div>
  );
}
