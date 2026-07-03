import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MapPin, Plus, Loader2, Pencil, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useWorkLocations, WorkLocation, WorkLocationType } from "@/hooks/useWorkLocations";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { PermissionGate } from "@/components/common/PermissionGate";
import { usePermissions } from "@/hooks/usePermissions";
import { PageHeader, PageBody } from "@/design-system";

const TYPE_LABELS: Record<WorkLocationType, string> = {
  office: "Office",
  remote: "Remote",
  other: "Other",
};

export default function WorkLocationsPage() {
  const navigate = useNavigate();
  const { locations, isLoading, remove } = useWorkLocations();
  const { can } = usePermissions();
  const canManage = can("manageWorkLocations");

  const goCreate = () => navigate("/hr/employees/locations/new");
  const goEdit = (l: WorkLocation) => navigate(`/hr/employees/locations/${l.id}/edit`);

  const del = useConfirmDelete<WorkLocation>({ onConfirm: async (l) => remove(l.id) });

  return (
    <>
      <PageHeader
        eyebrow="HR · Org"
        title="Work Locations"
        description="Where your people physically work — distinct from your legal branches."
        actions={
          <PermissionGate permission="manageWorkLocations">
            <Button onClick={goCreate}>
              <Plus className="h-4 w-4 mr-2" /> New Location
            </Button>
          </PermissionGate>
        }
      />
      <PageBody fullWidth className="gap-4 sm:gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <MapPin className="h-4 w-4" /> All locations
            </CardTitle>
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
                    <TableRow
                      key={l.id}
                      className={canManage ? "cursor-pointer hover:bg-muted/40" : undefined}
                      onClick={canManage ? () => goEdit(l) : undefined}
                    >
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
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        {canManage && (
                          <>
                            <Button variant="ghost" size="icon" onClick={() => goEdit(l)}>
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

        <ConfirmDeleteDialog
          open={del.isOpen}
          onOpenChange={del.setIsOpen}
          onConfirm={del.confirmDelete}
          isLoading={del.isDeleting}
          title="Delete work location"
          description={`Delete "${del.itemToDelete?.name}"?`}
        />
      </PageBody>
    </>
  );
}
