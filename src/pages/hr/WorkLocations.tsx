import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { WorkflowSheet, WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MapPin, Plus, Loader2, Pencil, Trash2 } from "lucide-react";
import { useWorkLocations, WorkLocation, WorkLocationType } from "@/hooks/useWorkLocations";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { PermissionGate } from "@/components/common/PermissionGate";
import { usePermissions } from "@/hooks/usePermissions";

const empty = {
  name: "",
  location_type: "office" as WorkLocationType,
  address: "",
  is_active: true,
};

const TYPE_LABELS: Record<WorkLocationType, string> = {
  office: "Office",
  remote: "Remote",
  other: "Other",
};

export default function WorkLocationsPage() {
  const { locations, isLoading, create, update, remove } = useWorkLocations();
  const { can } = usePermissions();
  const canManage = can("manageWorkLocations");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkLocation | null>(null);
  const [form, setForm] = useState(empty);
  const [submitting, setSubmitting] = useState(false);

  const open = (l?: WorkLocation) => {
    if (l) {
      setEditing(l);
      setForm({
        name: l.name,
        location_type: l.location_type,
        address: l.address ?? "",
        is_active: l.is_active,
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
        location_type: form.location_type,
        address: form.address.trim() || null,
        is_active: form.is_active,
      };
      if (editing) await update(editing.id, payload as any);
      else await create(payload as any);
      setDialogOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const del = useConfirmDelete<WorkLocation>({ onConfirm: async (l) => remove(l.id) });

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <MapPin className="h-6 w-6" /> Work Locations
          </h1>
          <p className="text-sm text-muted-foreground">
            Where your people physically work — distinct from your legal branches.
          </p>
        </div>
        <PermissionGate permission="manageWorkLocations">
          <Button onClick={() => open()}>
            <Plus className="h-4 w-4 mr-2" /> New Location
          </Button>
        </PermissionGate>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All locations</CardTitle>
          <CardDescription>Office, remote, or other.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : locations.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No work locations yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locations.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{TYPE_LABELS[l.location_type]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{l.address || "—"}</TableCell>
                    <TableCell>
                      <Badge variant={l.is_active ? "default" : "secondary"}>
                        {l.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <>
                          <Button variant="ghost" size="icon" onClick={() => open(l)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => del.requestDelete(l)}>
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
        title={editing ? "Edit Work Location" : "New Work Location"}
        description="A physical or virtual place where people work. Separate from legal branches."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!form.name.trim() || submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editing ? "Save changes" : "Create location"}
            </Button>
          </>
        }
      >
        <WorkflowSheetGrid>
          <WorkflowSheetSection number={1} title="Identity" subtitle="How this location appears across HR and Attendance.">
            <WorkflowField label="Name" required>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Nairobi HQ"
              />
            </WorkflowField>
            <WorkflowField label="Type">
              <Select
                value={form.location_type}
                onValueChange={(v) => setForm((f) => ({ ...f, location_type: v as WorkLocationType }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="office">Office</SelectItem>
                  <SelectItem value="remote">Remote</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={2} title="Address" subtitle="Used for compliance reporting and travel context.">
            <WorkflowField label="Street address">
              <Input
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                placeholder="123 Main St, Nairobi, KE"
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
        title="Delete work location"
        description={`Delete "${del.itemToDelete?.name}"?`}
      />
    </div>
  );
}
