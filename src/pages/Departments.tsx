import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useDepartments, Department, DepartmentStatus } from "@/hooks/useDepartments";
import { useEmployees } from "@/hooks/useEmployees";
import { usePermissions } from "@/hooks/usePermissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Search,
  Building2,
  MoreHorizontal,
  Loader2,
  Pencil,
  Trash2,
  Users,
  Eye,
  Archive,
  ArchiveRestore,
  Ban,
} from "lucide-react";
import { DepartmentDetailSheet } from "@/components/departments/DepartmentDetailSheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { useOrganization } from "@/hooks/useOrganization";
import { format } from "date-fns";
import { normalizeError } from "@/services/resilience";
import { PageHeader, PageBody } from "@/design-system";

export default function Departments() {
  const {
    departments,
    activeDepartments,
    archivedDepartments,
    dissolvedDepartments,
    isLoading,
    archiveDepartment,
    restoreDepartment,
    dissolveDepartment,
  } = useDepartments();
  const { activeEmployees } = useEmployees();
  const { can } = usePermissions();
  const { currentOrg } = useOrganization();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState("");
  const [detailDepartment, setDetailDepartment] = useState<Department | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [statusFilter, setStatusFilter] = useState<DepartmentStatus | "all">("active");

  const handleOpenDetail = (dept: Department) => {
    setDetailDepartment(dept);
    setShowDetail(true);
  };

  const handleOpenDialog = (department?: Department) => {
    navigate(
      department
        ? `/hr/employees/departments/${department.id}/edit`
        : "/hr/employees/departments/new",
    );
  };

  // Legacy deep-link redirect: `?action=create` or `?action=edit&id=...`
  // used by cross-module CTAs before Wave 13. Land users on the routed
  // create/edit pages transparently.
  useEffect(() => {
    const action = searchParams.get("action");
    if (action === "create") {
      searchParams.delete("action");
      setSearchParams(searchParams, { replace: true });
      navigate("/hr/employees/departments/new", { replace: true });
    } else if (action === "edit") {
      const id = searchParams.get("id");
      if (id) {
        searchParams.delete("action");
        searchParams.delete("id");
        setSearchParams(searchParams, { replace: true });
        navigate(`/hr/employees/departments/${id}/edit`, { replace: true });
      }
    }
  }, [searchParams, setSearchParams, navigate]);


  const executeDeleteDepartment = async (department: Department) => {
    try {
      await dissolveDepartment(department.id);
    } catch (error: any) {
      toast({
        title: "Cannot dissolve department",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const deleteConfirm = useConfirmDelete<Department>({ onConfirm: executeDeleteDepartment });

  const handleDissolve = (department: Department) => {
    deleteConfirm.requestDelete(department);
  };

  const handleArchive = async (department: Department) => {
    try {
      await archiveDepartment(department.id);
    } catch (error: any) {
      toast({ title: "Error archiving department", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleRestore = async (department: Department) => {
    try {
      await restoreDepartment(department.id);
    } catch (error: any) {
      toast({ title: "Error restoring department", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const departmentStatus = (d: Department): DepartmentStatus =>
    d.status ?? (d.is_active ? "active" : "archived");

  const filteredDepartments = departments
    .filter((dept) => statusFilter === "all" ? true : departmentStatus(dept) === statusFilter)
    .filter((dept) =>
      dept.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      dept.code?.toLowerCase().includes(searchQuery.toLowerCase())
    );

  const statusBadgeClass = (s: DepartmentStatus) =>
    s === "active"
      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
      : s === "archived"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
      : "bg-muted text-muted-foreground";

  const canManage = can("manageDepartments");

  return (
    <>
      <PageHeader
        eyebrow="HR · Org"
        title="Departments"
        description="Manage organizational departments and hierarchies."
        actions={
          canManage ? (
            <Button onClick={() => handleOpenDialog()}>
              <Plus className="mr-2 h-4 w-4" />
              Add Department
            </Button>
          ) : null
        }
      />
      <PageBody fullWidth className="gap-4 sm:gap-6">



        {/* Stats */}
        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{activeDepartments.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Archived</CardTitle>
              <Archive className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{archivedDepartments.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Dissolved</CardTitle>
              <Ban className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{dissolvedDepartments.length}</div>
            </CardContent>
          </Card>
        </div>

        {/* Search */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search departments..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 w-full"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as DepartmentStatus | "all")}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
              <SelectItem value="dissolved">Dissolved</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <ReportExportButtons
            getExportConfig={() => ({
              title: "Department Directory",
              companyName: currentOrg?.name || undefined,
              dateRange: `As of ${format(new Date(), "MMM d, yyyy")}`,
              columns: [
                { key: "name", header: "Department", width: 22 },
                { key: "code", header: "Code", width: 10 },
                { key: "manager", header: "Manager", width: 22 },
                { key: "parent", header: "Parent Dept", width: 18 },
                { key: "status", header: "Status", width: 10 },
              ],
              rows: filteredDepartments.map((d) => ({
                name: d.name,
                code: d.code || "—",
                manager: d.manager ? `${d.manager.first_name} ${d.manager.last_name}` : "—",
                parent: d.parent_department?.name || "—",
                status: departmentStatus(d).charAt(0).toUpperCase() + departmentStatus(d).slice(1),
              })),
              organizationId: currentOrg?.id,
            } as ExportConfig)}
            formats={["excel", "csv", "pdf"]}
            compact
          />
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredDepartments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No departments found</h3>
                <p className="text-muted-foreground">
                  {departments.length === 0
                    ? "Get started by adding your first department."
                    : "Try adjusting your search."}
                </p>
              </div>
            ) : (
              <>
                {/* Mobile Card View */}
                <div className="md:hidden p-3 space-y-3">
                  {filteredDepartments.map((dept) => (
                    <div
                      key={dept.id}
                      className="border rounded-lg p-3 space-y-2 cursor-pointer hover:bg-accent/40 active:bg-accent/60 transition-colors"
                      role="button"
                      tabIndex={0}
                      onClick={() => handleOpenDetail(dept)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleOpenDetail(dept);
                        }
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-sm">{dept.name}</div>
                          {dept.description && (
                            <div className="text-xs text-muted-foreground line-clamp-1">{dept.description}</div>
                          )}
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 flex-shrink-0"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem onClick={() => handleOpenDetail(dept)}>
                              <Eye className="mr-2 h-4 w-4" /> View details
                            </DropdownMenuItem>
                            {canManage && (
                              <>
                                <DropdownMenuItem onClick={() => handleOpenDialog(dept)}>
                                  <Pencil className="mr-2 h-4 w-4" /> Edit
                                </DropdownMenuItem>
                                {departmentStatus(dept) === "active" && (
                                  <DropdownMenuItem onClick={() => handleArchive(dept)}>
                                    <Archive className="mr-2 h-4 w-4" /> Archive
                                  </DropdownMenuItem>
                                )}
                                {departmentStatus(dept) === "archived" && (
                                  <DropdownMenuItem onClick={() => handleRestore(dept)}>
                                    <ArchiveRestore className="mr-2 h-4 w-4" /> Restore
                                  </DropdownMenuItem>
                                )}
                                {departmentStatus(dept) !== "dissolved" && (
                                  <DropdownMenuItem onClick={() => handleDissolve(dept)} className="text-destructive">
                                    <Ban className="mr-2 h-4 w-4" /> Dissolve
                                  </DropdownMenuItem>
                                )}
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="text-xs">{dept.code || "—"}</Badge>
                        <Badge
                          className={`text-xs ${statusBadgeClass(departmentStatus(dept))}`}
                        >
                          {departmentStatus(dept)}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        <div>Manager: {dept.manager ? `${dept.manager.first_name} ${dept.manager.last_name}` : "—"}</div>
                        <div>Parent: {dept.parent_department?.name || "—"}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop Table View */}
                <div className="hidden md:block table-container">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Code</TableHead>
                        <TableHead>Manager</TableHead>
                        <TableHead>Parent</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-12"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredDepartments.map((dept) => (
                        <TableRow
                          key={dept.id}
                          className="cursor-pointer hover:bg-muted/40"
                          onClick={() => handleOpenDetail(dept)}
                        >
                          <TableCell>
                            <div>
                              <div className="font-medium">{dept.name}</div>
                              {dept.description && (
                                <div className="text-sm text-muted-foreground line-clamp-1">
                                  {dept.description}
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{dept.code || "—"}</Badge>
                          </TableCell>
                          <TableCell>
                            {dept.manager
                              ? `${dept.manager.first_name} ${dept.manager.last_name}`
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {dept.parent_department?.name || "—"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={statusBadgeClass(departmentStatus(dept))}
                            >
                              {departmentStatus(dept)}
                            </Badge>
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleOpenDetail(dept)}>
                                  <Eye className="mr-2 h-4 w-4" />
                                  View details
                                </DropdownMenuItem>
                                {canManage && (
                                  <>
                                    <DropdownMenuItem onClick={() => handleOpenDialog(dept)}>
                                      <Pencil className="mr-2 h-4 w-4" />
                                      Edit
                                    </DropdownMenuItem>
                                    {departmentStatus(dept) === "active" && (
                                      <DropdownMenuItem onClick={() => handleArchive(dept)}>
                                        <Archive className="mr-2 h-4 w-4" /> Archive
                                      </DropdownMenuItem>
                                    )}
                                    {departmentStatus(dept) === "archived" && (
                                      <DropdownMenuItem onClick={() => handleRestore(dept)}>
                                        <ArchiveRestore className="mr-2 h-4 w-4" /> Restore
                                      </DropdownMenuItem>
                                    )}
                                    {departmentStatus(dept) !== "dissolved" && (
                                      <DropdownMenuItem
                                        onClick={() => handleDissolve(dept)}
                                        className="text-destructive"
                                      >
                                        <Ban className="mr-2 h-4 w-4" />
                                        Dissolve
                                      </DropdownMenuItem>
                                    )}
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Delete Confirmation Dialog */}
        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          title="Dissolve Department"
          itemName={deleteConfirm.itemToDelete?.name}
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />

        <DepartmentDetailSheet
          department={detailDepartment}
          open={showDetail}
          onOpenChange={setShowDetail}
          allDepartments={departments}
          employees={activeEmployees}
          canManage={canManage}
          onEdit={handleOpenDialog}
          onDelete={handleDissolve}
        />
      </PageBody>
    </>
  );
}
