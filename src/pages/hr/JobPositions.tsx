import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Briefcase, Plus, Loader2, Pencil, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useJobPositions, JobPosition } from "@/hooks/useJobPositions";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { PermissionGate } from "@/components/common/PermissionGate";
import { usePermissions } from "@/hooks/usePermissions";
import { PageHeader, PageBody } from "@/design-system";

export default function JobPositionsPage() {
  const navigate = useNavigate();
  const { positions, isLoading, remove } = useJobPositions();
  const { can } = usePermissions();
  const canManage = can("manageJobPositions");

  const goCreate = () => navigate("/hr/employees/positions/new");
  const goEdit = (p: JobPosition) => navigate(`/hr/employees/positions/${p.id}/edit`);

  const del = useConfirmDelete<JobPosition>({ onConfirm: async (p) => remove(p.id) });

  return (
    <>
      <PageHeader
        eyebrow="HR · Org"
        title="Job Positions"
        description="Reusable catalog of roles in your company. Used by Employees and Recruitment."
        actions={
          <PermissionGate permission="manageJobPositions">
            <Button onClick={goCreate}>
              <Plus className="h-4 w-4 mr-2" /> New Position
            </Button>
          </PermissionGate>
        }
      />
      <PageBody fullWidth className="gap-4 sm:gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Briefcase className="h-4 w-4" /> All positions
            </CardTitle>
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
                    <TableRow
                      key={p.id}
                      className={canManage ? "cursor-pointer hover:bg-muted/40" : undefined}
                      onClick={canManage ? () => goEdit(p) : undefined}
                    >
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
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        {canManage && (
                          <>
                            <Button variant="ghost" size="icon" onClick={() => goEdit(p)}>
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

        <ConfirmDeleteDialog
          open={del.isOpen}
          onOpenChange={del.setIsOpen}
          onConfirm={del.confirmDelete}
          isLoading={del.isDeleting}
          title="Delete job position"
          description={`Delete "${del.itemToDelete?.name}"? This cannot be undone.`}
        />
      </PageBody>
    </>
  );
}
