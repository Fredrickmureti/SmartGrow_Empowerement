import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Badge } from "@/components/ui/badge";
import { useLeaveAllocations } from "@/hooks/leave/useLeaveAllocations";
import { useLeaveAccruals } from "@/hooks/leave/useLeaveAccruals";
import { useLeaveTypes } from "@/hooks/leave/useLeaveTypes";
import { useEmployees } from "@/hooks/useEmployees";
import { useCurrency } from "@/hooks/useCurrency";
import { PermissionGate } from "@/components/common/PermissionGate";
import { Plus, Search, Loader2, Users, Calendar, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { useOrganization } from "@/hooks/useOrganization";
import { normalizeError } from "@/services/resilience";

export default function LeaveAllocations() {
  const { allocations, isLoading, bulkAllocate, createAllocation, deleteAllocation } = useLeaveAllocations();
  const { leaveTypes } = useLeaveTypes();
  const { processAccruals, isProcessing, getAccrualLeaveTypes } = useLeaveAccruals();
  const { activeEmployees } = useEmployees();
  const { currentOrg } = useOrganization();
  const [searchQuery, setSearchQuery] = useState("");
  const [showBulkDialog, setShowBulkDialog] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Bulk allocation form
  const [bulkLeaveTypeId, setBulkLeaveTypeId] = useState("");
  const [bulkDays, setBulkDays] = useState("");
  const [bulkYear, setBulkYear] = useState(new Date().getFullYear().toString());
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [selectAll, setSelectAll] = useState(false);

  const filteredAllocations = allocations.filter((a) => {
    const empName = a.employee ? `${a.employee.first_name} ${a.employee.last_name}`.toLowerCase() : "";
    const typeName = a.leave_type?.name?.toLowerCase() || "";
    const q = searchQuery.toLowerCase();
    return empName.includes(q) || typeName.includes(q);
  });

  const handleSelectAll = (checked: boolean) => {
    setSelectAll(checked);
    setSelectedEmployeeIds(checked ? activeEmployees.map(e => e.id) : []);
  };

  const toggleEmployee = (id: string) => {
    setSelectedEmployeeIds(prev =>
      prev.includes(id) ? prev.filter(e => e !== id) : [...prev, id]
    );
  };

  const handleBulkAllocate = async () => {
    if (!bulkLeaveTypeId || !bulkDays || selectedEmployeeIds.length === 0) {
      toast.error("Please fill all fields and select at least one employee");
      return;
    }
    setIsSubmitting(true);
    try {
      await bulkAllocate(selectedEmployeeIds, bulkLeaveTypeId, Number(bulkDays), Number(bulkYear));
      setShowBulkDialog(false);
      resetBulkForm();
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to allocate leave");
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetBulkForm = () => {
    setBulkLeaveTypeId("");
    setBulkDays("");
    setBulkYear(new Date().getFullYear().toString());
    setSelectedEmployeeIds([]);
    setSelectAll(false);
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Leave Allocations</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Manage employee leave balances and bulk allocations
            </p>
          </div>
          <PermissionGate permission="manageLeaveTypes">
            <div className="action-buttons w-full sm:w-auto">
              {getAccrualLeaveTypes().length > 0 && (
                <Button variant="outline"
                  onClick={() => processAccruals()}
                  disabled={isProcessing}
                  className="flex-1 sm:flex-none"
                >
                  <RefreshCw className={`h-4 w-4 sm:mr-2 ${isProcessing ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">{isProcessing ? "Processing..." : "Run Accruals"}</span>
                  <span className="sm:hidden">{isProcessing ? "..." : "Accrue"}</span>
                </Button>
              )}
              <Button onClick={() => setShowBulkDialog(true)} className="flex-1 sm:flex-none">
                <Users className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Bulk Allocate</span>
                <span className="sm:hidden">Allocate</span>
              </Button>
            </div>
          </PermissionGate>
        </div>

        {/* Stats */}
        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Allocations</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{allocations.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Employees</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{activeEmployees.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Leave Types</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{leaveTypes.length}</div>
            </CardContent>
          </Card>
        </div>

        {/* Filter */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by employee or leave type..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 w-full"
            />
          </div>
          <ReportExportButtons
            getExportConfig={() => ({
              title: "Leave Allocations",
              companyName: currentOrg?.name || undefined,
              dateRange: `As of ${format(new Date(), "MMM d, yyyy")}`,
              columns: [
                { key: "employee", header: "Employee", width: 22 },
                { key: "leave_type", header: "Leave Type", width: 16 },
                { key: "year", header: "Year", width: 8 },
                { key: "allocated", header: "Allocated", format: "number", width: 10, align: "right" },
                { key: "used", header: "Used", format: "number", width: 10, align: "right" },
                { key: "available", header: "Available", format: "number", width: 10, align: "right" },
                { key: "type", header: "Allocation Type", width: 14 },
              ],
              rows: filteredAllocations.map((a) => ({
                employee: a.employee ? `${a.employee.first_name} ${a.employee.last_name}` : "—",
                leave_type: a.leave_type?.name || "—",
                year: a.year,
                allocated: a.days_allocated,
                used: a.days_used,
                available: a.days_allocated - a.days_used,
                type: a.allocation_type,
              })),
              organizationId: currentOrg?.id,
            } as ExportConfig)}
            formats={["excel", "csv", "pdf"]}
            compact
          />
        </div>

        {/* Allocations Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredAllocations.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <Calendar className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No allocations found</h3>
                <p className="text-muted-foreground text-sm">
                  Use "Bulk Allocate" to assign leave days to employees.
                </p>
              </div>
            ) : (
              <div className="table-container">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead>Leave Type</TableHead>
                      <TableHead>Year</TableHead>
                      <TableHead className="text-right">Allocated</TableHead>
                      <TableHead className="text-right">Used</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead>Type</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAllocations.map((alloc) => (
                      <TableRow key={alloc.id}>
                        <TableCell className="font-medium">
                          {alloc.employee ? `${alloc.employee.first_name} ${alloc.employee.last_name}` : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {alloc.leave_type && (
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: alloc.leave_type.color }} />
                            )}
                            {alloc.leave_type?.name || "—"}
                          </div>
                        </TableCell>
                        <TableCell>{alloc.year}</TableCell>
                        <TableCell className="text-right">{alloc.days_allocated}</TableCell>
                        <TableCell className="text-right">{alloc.days_used}</TableCell>
                        <TableCell className="text-right font-medium">
                          {alloc.days_allocated - alloc.days_used}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">{alloc.allocation_type}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Bulk Allocation Workflow */}
        <WorkflowSheet
          open={showBulkDialog}
          onOpenChange={setShowBulkDialog}
          title="Bulk leave allocation"
          description="Allocate leave days to multiple employees at once."
          size="xl"
          footer={
            <>
              <Button variant="outline" onClick={() => setShowBulkDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleBulkAllocate}
                disabled={
                  isSubmitting ||
                  selectedEmployeeIds.length === 0 ||
                  !bulkLeaveTypeId ||
                  !bulkDays
                }
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Allocating…
                  </>
                ) : (
                  `Allocate to ${selectedEmployeeIds.length} employee${selectedEmployeeIds.length === 1 ? "" : "s"}`
                )}
              </Button>
            </>
          }
        >
          <WorkflowSheetSection number={1} title="Allocation" fullWidth>
            <WorkflowSheetGrid columns={3}>
              <WorkflowField label="Leave type" required>
                <Select value={bulkLeaveTypeId} onValueChange={setBulkLeaveTypeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {leaveTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </WorkflowField>
              <WorkflowField label="Days to allocate" required>
                <Input
                  type="number"
                  min="0.5"
                  step="0.5"
                  value={bulkDays}
                  onChange={(e) => setBulkDays(e.target.value)}
                  placeholder="e.g. 21"
                />
              </WorkflowField>
              <WorkflowField label="Year" required>
                <Input
                  type="number"
                  value={bulkYear}
                  onChange={(e) => setBulkYear(e.target.value)}
                />
              </WorkflowField>
            </WorkflowSheetGrid>
          </WorkflowSheetSection>

          <WorkflowSheetSection
            number={2}
            title="Target employees"
            subtitle={`${selectedEmployeeIds.length} of ${activeEmployees.length} selected`}
            right={
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Checkbox
                  checked={selectAll}
                  onCheckedChange={(checked) => handleSelectAll(!!checked)}
                />
                Select all
              </label>
            }
            fullWidth
          >
            <div className="border rounded-md max-h-72 overflow-y-auto divide-y">
              {activeEmployees.map((emp) => (
                <label
                  key={emp.id}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedEmployeeIds.includes(emp.id)}
                    onCheckedChange={() => toggleEmployee(emp.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {emp.first_name} {emp.last_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {emp.employee_number}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </WorkflowSheetSection>
        </WorkflowSheet>
      </div>
    </>
  );
}
