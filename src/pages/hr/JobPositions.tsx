import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { WorkflowSheet, WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Briefcase, Plus, Loader2, Pencil, Trash2 } from "lucide-react";
import { useJobPositions, JobPosition } from "@/hooks/useJobPositions";
import { useDepartments } from "@/hooks/useDepartments";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { PermissionGate } from "@/components/common/PermissionGate";
import { usePermissions } from "@/hooks/usePermissions";

const empty = {
  name: "",
  code: "",
  department_id: "",
  description: "",
  target_headcount: "" as string,
  is_active: true,
};

export default function JobPositionsPage() {
  const { positions, isLoading, create, update, remove } = useJobPositions();
  const { activeDepartments } = useDepartments();
  const { can } = usePermissions();
  const canManage = can("manageJobPositions");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<JobPosition | null>(null);
  const [form, setForm] = useState(empty);
  const [submitting, setSubmitting] = useState(false);

  const open = (p?: JobPosition) => {
    if (p) {
      setEditing(p);
      setForm({
        name: p.name,
        code: p.code ?? "",
        department_id: p.department_id ?? "",
        description: p.description ?? "",
        target_headcount: p.target_headcount?.toString() ?? "",
        is_active: p.is_active,
      });
    } else {
      setEditing(null);
      setForm(empty);
    }
    setDialogOpen(true);
  };

  const submit = async () => {
    if (!form.name.trim()) return;
    setSubmitting(true);
    try {
      const payload = {
        name: form.name.trim(),
        code: form.code.trim() || null,
        department_id: form.department_id || null,
        description: form.description.trim() || null,
        target_headcount: form.target_headcount ? parseInt(form.target_headcount, 10) : null,
        is_active: form.is_active,
      };
      if (editing) await update(editing.id, payload as any);
      else await create(payload as any);
      setDialogOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const del = useConfirmDelete<JobPosition>({ onConfirm: async (p) => remove(p.id) });

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <Briefcase className="h-6 w-6" /> Job Positions
          </h1>
          <p className="text-sm text-muted-foreground">
            Reusable catalog of roles in your company. Used by Employees and Recruitment.
          </p>
        </div>
        <PermissionGate permission="manageJobPositions">
          <Button onClick={() => open()}>
            <Plus className="h-4 w-4 mr-2" /> New Position
          </Button>
        </PermissionGate>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All positions</CardTitle>
          <CardDescription>Filled vs target headcount per role.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : positions.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No job positions yet. Create one to start standardizing job titles.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead className="text-right">Headcount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>{p.department_name || "—"}</TableCell>
                    <TableCell>{p.code || "—"}</TableCell>
                    <TableCell className="text-right">
                      {p.headcount}
                      {p.target_headcount != null && (
                        <span className="text-muted-foreground"> / {p.target_headcount}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.is_active ? "default" : "secondary"}>
                        {p.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <>
                          <Button variant="ghost" size="icon" onClick={() => open(p)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => del.requestDelete(p)}
                            disabled={(p.headcount ?? 0) > 0}
                            title={(p.headcount ?? 0) > 0 ? "Cannot delete: position is in use" : "Delete"}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <WorkflowSheet
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? "Edit Job Position" : "New Job Position"}
        description="Reusable role catalog. Drives employee org placement, headcount planning and recruitment."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!form.name.trim() || submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editing ? "Save changes" : "Create position"}
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Identity" subtitle="How the role appears in directories, org charts and recruitment.">
          <WorkflowField label="Name" required>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Senior Accountant"
            />
          </WorkflowField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Code" hint="Short internal identifier.">
              <Input
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                placeholder="e.g. SR-ACCT"
              />
            </WorkflowField>
            <WorkflowField label="Target headcount" hint="Used for capacity planning.">
              <Input
                type="number"
                min={0}
                value={form.target_headcount}
                onChange={(e) => setForm((f) => ({ ...f, target_headcount: e.target.value }))}
              />
            </WorkflowField>
          </div>
        </WorkflowSheetSection>

        <WorkflowSheetGrid>
          <WorkflowSheetSection number={2} title="Org placement" subtitle="Where this role sits in your structure.">
            <WorkflowField label="Department">
              <Select
                value={form.department_id}
                onValueChange={(v) => setForm((f) => ({ ...f, department_id: v }))}
              >
                <SelectTrigger><SelectValue placeholder="No department" /></SelectTrigger>
                <SelectContent>
                  {activeDepartments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={3} title="Description" subtitle="Optional summary shown on the position profile.">
            <WorkflowField label="Description">
              <Textarea
                rows={4}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </WorkflowField>
          </WorkflowSheetSection>
        </WorkflowSheetGrid>
      </WorkflowSheet>

      <ConfirmDeleteDialog
        open={del.isOpen}
        onOpenChange={del.setIsOpen}
        onConfirm={del.confirmDelete}
        isLoading={del.isDeleting}
        title="Delete job position"
        description={`Delete "${del.itemToDelete?.name}"? This cannot be undone.`}
      />
    </div>
  );
}
