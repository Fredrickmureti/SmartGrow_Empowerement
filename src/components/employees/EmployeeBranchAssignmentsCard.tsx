/**
 * EmployeeBranchAssignmentsCard — Phase C, HR Architecture Review.
 *
 * Manages the 0..N branch assignments on an employee. The legacy
 * `employees.branch_id` column is a maintained mirror of whichever row here
 * carries `is_primary=true`; direct writes to it are blocked by a DB trigger.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { WorkflowSheet, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";


import { Loader2, Plus, X, Building2 } from "lucide-react";
import { useBranches } from "@/hooks/useBranches";
import {
  useEmployeeBranchAssignments,
  type AssignmentType,
} from "@/hooks/hr/useEmployeeBranchAssignments";
import { format } from "date-fns";
import { normalizeError } from "@/services/resilience";
import { toast } from "sonner";

interface Props {
  employeeId: string;
  canEdit: boolean;
}

const ASSIGNMENT_TYPES: { value: AssignmentType; label: string }[] = [
  { value: "permanent", label: "Permanent" },
  { value: "secondment", label: "Secondment" },
  { value: "temporary", label: "Temporary" },
  { value: "coverage", label: "Coverage" },
];

export function EmployeeBranchAssignmentsCard({ employeeId, canEdit }: Props) {
  const { branches } = useBranches();
  const { assignments, isLoading, assign, end } = useEmployeeBranchAssignments(employeeId);

  const [open, setOpen] = useState(false);
  const [branchId, setBranchId] = useState<string>("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [type, setType] = useState<AssignmentType>("permanent");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const resetForm = () => {
    setBranchId("");
    setIsPrimary(false);
    setType("permanent");
    setEffectiveFrom(new Date().toISOString().slice(0, 10));
    setNotes("");
  };

  const submit = async () => {
    if (!branchId) {
      toast.error("Select a branch");
      return;
    }
    setBusy(true);
    try {
      await assign({ branchId, isPrimary, assignmentType: type, effectiveFrom, notes });
      setOpen(false);
      resetForm();
    } catch (e) {
      toast.error(normalizeError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const handleEnd = async (id: string) => {
    try {
      await end(id);
    } catch (e) {
      toast.error(normalizeError(e).message);
    }
  };

  const active = assignments.filter((a) => !a.effective_to);
  const ended = assignments.filter((a) => a.effective_to);

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          Branch Assignments
        </CardTitle>
        {canEdit && (
          <>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Assign
            </Button>
            <WorkflowSheet
              open={open}
              onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}
              size="md"
              title="Assign to branch"
              description="Attach the employee to an additional branch with an effective date and role."
              footer={
                <>
                  <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                  <Button onClick={submit} disabled={busy}>
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Assign
                  </Button>
                </>
              }
            >
              <WorkflowSheetSection number={1} title="Branch" subtitle="Where the employee will be active.">
                <WorkflowField label="Branch" required>
                  <Select value={branchId} onValueChange={setBranchId}>
                    <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => (
                        <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </WorkflowField>
              </WorkflowSheetSection>
              <WorkflowSheetSection number={2} title="Assignment" subtitle="Type and start date for this assignment.">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <WorkflowField label="Type">
                    <Select value={type} onValueChange={(v) => setType(v as AssignmentType)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ASSIGNMENT_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </WorkflowField>
                  <WorkflowField label="Effective from">
                    <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
                  </WorkflowField>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={isPrimary}
                    onChange={(e) => setIsPrimary(e.target.checked)}
                  />
                  Make this the primary branch
                </label>
              </WorkflowSheetSection>
              <WorkflowSheetSection number={3} title="Notes" subtitle="Optional context surfaced on the assignment history.">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional context" />
              </WorkflowSheetSection>
            </WorkflowSheet>
          </>
        )}

      </CardHeader>

      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
          </div>
        ) : assignments.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            No branch assignments. This employee is visible to every branch (HQ / remote).
          </p>
        ) : (
          <div className="space-y-3">
            {active.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Active</div>
                {active.map((a) => (
                  <div key={a.id} className="flex items-center justify-between border rounded-md px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">{a.branch_name ?? a.branch_id}</span>
                        {a.is_primary && <Badge variant="default">Primary</Badge>}
                        <Badge variant="outline" className="capitalize">{a.assignment_type}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Since {format(new Date(a.effective_from), "MMM d, yyyy")}
                        {a.notes ? ` · ${a.notes}` : ""}
                      </div>
                    </div>
                    {canEdit && (
                      <Button size="sm" variant="ghost" onClick={() => handleEnd(a.id)}>
                        <X className="h-4 w-4 mr-1" /> End
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {ended.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">History</div>
                {ended.map((a) => (
                  <div key={a.id} className="flex items-center justify-between border rounded-md px-3 py-2 opacity-70">
                    <div>
                      <div className="text-sm">
                        {a.branch_name ?? a.branch_id}
                        <span className="ml-2 text-xs capitalize text-muted-foreground">{a.assignment_type}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {format(new Date(a.effective_from), "MMM d, yyyy")} → {a.effective_to ? format(new Date(a.effective_to), "MMM d, yyyy") : "—"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
