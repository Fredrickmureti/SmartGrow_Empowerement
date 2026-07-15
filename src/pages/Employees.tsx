import { normalizeError } from "@/services/resilience";
/**
 * Employees Directory — Wave H F6.
 *
 * Server-side cursor pagination via `useEmployeesPaged` + server-side
 * aggregates via `useEmployeeDirectoryStats`. The shared `useEmployees`
 * hook is kept ONLY for its mutation helpers (no list fetch on this page).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { Plus, Search, Users, Loader2, UserCheck, UserX, Briefcase, Upload, LayoutGrid, List as ListIcon, AlertTriangle, ChevronDown, Zap } from "lucide-react";

import { useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import type { EmployeeFormData } from "@/components/employees/EmployeeFormDialog";
import { useEmployees, type Employee } from "@/hooks/useEmployees";
import { useEmployeesPaged, type DirectoryEmployee } from "@/hooks/hr/useEmployeesPaged";
import { useEmployeeDirectoryStats } from "@/hooks/hr/useEmployeeDirectoryStats";
import { useDepartments } from "@/hooks/useDepartments";
import { useJobPositions } from "@/hooks/useJobPositions";
import { useWorkLocations } from "@/hooks/useWorkLocations";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { PageHeader, PageBody } from "@/design-system";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { supabase } from "@/integrations/supabase/client";
import { useEmployeeSelection } from "@/hooks/hr/useEmployeeSelection";
import type { SetupVerdict, SetupHealthRow } from "@/hooks/hr/useEmployeeSetupHealth";
import { useDebouncedValue } from "@/hooks/useDebouncedCallback";
import { buildEmployeePayload } from "@/lib/hr/buildEmployeePayload";
import { performEmployeeImport } from "@/lib/hr/performEmployeeImport";
import { useEmployeeImportFields } from "@/hooks/hr/useEmployeeImportFields";

import { StatCard } from "@/components/employees/directory/StatCard";
import { FilterSelect } from "@/components/employees/directory/FilterSelect";
import { EmptyState } from "@/components/employees/directory/EmptyState";
import { CardGrid } from "@/components/employees/directory/CardGrid";
import { DesktopTable } from "@/components/employees/directory/DesktopTable";
import { RowActions } from "@/components/employees/directory/RowActions";
import { BulkActionBar } from "@/components/employees/directory/BulkActionBar";
import { positionName } from "@/components/employees/directory/helpers";
import { EmployeeDirectoryDialogs } from "@/components/employees/directory/EmployeeDirectoryDialogs";
import { BulkAssignDialog } from "@/components/employees/directory/BulkAssignDialog";
import { EmployeeQuickViewSheet } from "@/components/employees/EmployeeQuickViewSheet";

export default function Employees() {
  const navigate = useNavigate();
  // Mutations only — directory list comes from useEmployeesPaged.
  const {
    createEmployee, updateEmployee, deleteEmployee, calculateGrossPay,
  } = useEmployees({ enabled: false });
  const { formatCurrency, isReady: currencyReady } = useCurrency();
  const { can } = usePermissions();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { activeDepartments } = useDepartments();
  const { activePositions } = useJobPositions();
  const { activeLocations } = useWorkLocations();
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const [showDialog, setShowDialog] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [terminatingEmployee, setTerminatingEmployee] = useState<Employee | null>(null);
  const [linkDialogEmployee, setLinkDialogEmployee] = useState<Employee | null>(null);
  const [managerDialogEmployee, setManagerDialogEmployee] = useState<Employee | null>(null);
  const [inviteDialogEmployee, setInviteDialogEmployee] = useState<Employee | null>(null);
  const [bulkDept, setBulkDept] = useState(false);
  const [bulkLoc, setBulkLoc] = useState(false);
  const [quickViewEmployee, setQuickViewEmployee] = useState<Employee | null>(null);
  const [transferEmployee, setTransferEmployee] = useState<Employee | null>(null);
  const [compensationEmployee, setCompensationEmployee] = useState<Employee | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const searchQuery = useDebouncedValue(searchInput, 300);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive" | "drafts">("active");
  const [deptFilter, setDeptFilter] = useState("all");
  const [positionFilter, setPositionFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [healthFilter, setHealthFilter] = useState<"all" | SetupVerdict>("all");
  const [view, setView] = useState<"table" | "cards">("table");

  const selection = useEmployeeSelection();

  const pagedFilters = useMemo(
    () => ({
      search: searchQuery,
      status: statusFilter,
      departmentId: deptFilter,
      positionId: positionFilter,
      locationId: locationFilter,
      health: healthFilter,
    }),
    [searchQuery, statusFilter, deptFilter, positionFilter, locationFilter, healthFilter],
  );

  const {
    employees, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, refetch: refetchPage,
  } = useEmployeesPaged(pagedFilters);

  const { stats, refetch: refetchStats } = useEmployeeDirectoryStats();

  const refreshEmployees = useCallback(async () => {
    await Promise.all([refetchPage(), refetchStats()]);
  }, [refetchPage, refetchStats]);

  // Health verdict map for the existing pill/card subcomponents.
  const healthById = useMemo(() => {
    const m = new Map<string, SetupHealthRow>();
    for (const e of employees) {
      if (!e.health_verdict) continue;
      m.set(e.id, {
        employee_id: e.id,
        has_active_employment: e.is_active,
        has_active_contract: false,
        open_blocking_findings: 0,
        open_warn_findings: 0,
        verdict: e.health_verdict,
      });
    }
    return m;
  }, [employees]);

  // "Load more" sentinel — IntersectionObserver auto-fetches the next page.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleOpenDialog = (employee?: Employee) => {
    if (isReadOnly) return openUpgradeModal("employees");
    setEditingEmployee(employee || null);
    setShowDialog(true);
  };

  const handleSubmit = async (form: EmployeeFormData) => {
    try {
      const payload: any = buildEmployeePayload(form, {
        user_id: editingEmployee?.user_id ?? null,
        manager_id: editingEmployee?.manager_id ?? null,
      });
      let employeeId: string | null = null;
      const countryCode = (currentBusiness?.country || "").toUpperCase().trim();

      if (editingEmployee) {
        await updateEmployee(editingEmployee.id, payload);
        employeeId = editingEmployee.id;
      } else {
        const identifiers = Object.entries(form.statutory_identifiers ?? {})
          .filter(([, v]) => (v ?? "").trim() !== "")
          .map(([identifier_type, identifier_value]) => ({ identifier_type, identifier_value }));
        if (identifiers.length > 0 && !countryCode) {
          toast({ title: "Company country missing", description: "Set the company country in Settings before saving statutory identifiers.", variant: "destructive" });
          return;
        }
        const employeePayload = {
          ...payload,
          organization_id: currentOrg?.id ?? null,
          business_id: currentBusiness?.id ?? null,
          _country_code: countryCode || null,
        };
        const { data: newId, error: rpcErr } = await supabase.rpc(
          "create_employee_with_identifiers" as any,
          { p_employee: employeePayload, p_identifiers: identifiers },
        );
        if (rpcErr) throw rpcErr;
        employeeId = (newId as any) as string;
        await refreshEmployees();
      }

      if (editingEmployee && employeeId && currentOrg?.id && form.statutory_identifiers) {
        const entries = Object.entries(form.statutory_identifiers);
        if (entries.length > 0) {
          if (!countryCode) {
            toast({ title: "Company country missing", description: "Set the company country in Settings before saving statutory identifiers.", variant: "destructive" });
            return;
          }
          const types = entries.map(([k]) => k);
          await supabase
            .from("employee_statutory_identifiers")
            .delete()
            .eq("employee_id", employeeId)
            .in("identifier_type", types);
          const toInsert = entries
            .filter(([, v]) => (v ?? "").trim() !== "")
            .map(([identifier_type, identifier_value]) => ({
              employee_id: employeeId!,
              organization_id: currentOrg.id,
              business_id: currentBusiness?.id ?? null,
              country_code: countryCode,
              identifier_type,
              identifier_value: identifier_value.trim(),
              is_active: true,
            }));
          if (toInsert.length > 0) {
            const { error: insErr } = await supabase
              .from("employee_statutory_identifiers")
              .insert(toInsert as any);
            if (insErr) throw insErr;
          }
        }
      }
      await refreshEmployees();
    } catch (err: any) {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
      throw err;
    }
  };

  const { fields: dynamicImportFields } = useEmployeeImportFields(
    currentOrg?.id,
    currentBusiness?.id,
  );

  const handleImportEmployee = async (row: Record<string, any>) => {
    if (!currentOrg?.id) return;
    const { warnings } = await performEmployeeImport(row, {
      supabase: supabase as any,
      createEmployee: (payload) => createEmployee(payload as any) as any,
      organizationId: currentOrg.id,
      businessId: currentBusiness?.id ?? null,
    });
    if (warnings.length > 0) {
      toast({
        title: `Import: ${row.first_name ?? ""} ${row.last_name ?? ""}`.trim(),
        description: warnings.join(" "),
      });
    }
  };

  const executeDeleteEmployee = async (employee: Employee) => {
    try { await deleteEmployee(employee.id); await refreshEmployees(); }
    catch (error: any) {
      toast({ title: "Error deleting employee", description: normalizeError(error).message, variant: "destructive" });
    }
  };
  const deleteConfirm = useConfirmDelete<Employee>({ onConfirm: executeDeleteEmployee });

  const handleToggleStatus = async (employee: Employee) => {
    if (!employee.is_active && (employee as any).termination_date) {
      try {
        const { error } = await supabase.rpc("rehire_employee" as any, {
          p_employee_id: employee.id,
          p_start_date: new Date().toISOString().slice(0, 10),
          p_employment_type: employee.employment_type ?? "full_time",
          p_business_id: (employee as any).business_id ?? null,
          p_branch_id: (employee as any).branch_id ?? null,
        });
        if (error) throw error;
        toast({ title: "Employee rehired", description: `${employee.first_name} ${employee.last_name} now has a new active employment spell.` });
        await refreshEmployees();
      } catch (error: any) {
        toast({ title: "Rehire failed", description: normalizeError(error).message, variant: "destructive" });
      }
      return;
    }
    try { await updateEmployee(employee.id, { is_active: !employee.is_active }); await refreshEmployees(); }
    catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleTerminate = async (
    employeeId: string,
    _data: { termination_date: string; is_active: boolean },
    exitData: {
      termination_type: string;
      termination_reason: string;
      exit_checklist: Record<string, boolean>;
      final_settlement_notes: string;
    },
  ) => {
    try {
      const { error } = await supabase.rpc("terminate_employee" as any, {
        p_employee_id: employeeId,
        p_end_date: _data.termination_date,
        p_type: exitData.termination_type,
        p_reason: exitData.termination_reason || null,
        p_exit_data: exitData as any,
      });
      if (error) throw error;
      await refreshEmployees();
      setTerminatingEmployee(null);
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  // Server-side filtering — `employees` is already the filtered set.
  const filteredEmployees = employees as unknown as Employee[];

  const needsAttentionCount = stats.needs_attention;
  const totalPayroll = stats.monthly_payroll;

  // Export: pull every matching id via the ids RPC, then fetch full rows in
  // chunks via the paged RPC. Cap to avoid runaway exports.
  const exportConfig = (): ExportConfig => ({
    title: "Employee Directory",
    companyName: currentOrg?.name || undefined,
    dateRange: `As of ${format(new Date(), "MMM d, yyyy")}`,
    columns: [
      { key: "employee_number", header: "Emp #", width: 12 },
      { key: "name", header: "Full Name", width: 22 },
      { key: "email", header: "Email", width: 22 },
      { key: "department", header: "Department", width: 15 },
      { key: "position", header: "Position", width: 15 },
      { key: "status", header: "Status", width: 10 },
      { key: "hire_date", header: "Hire Date", width: 12 },
      { key: "basic_salary", header: "Basic Salary", format: "currency", width: 14, align: "right" },
    ],
    rows: filteredEmployees.map((emp) => ({
      employee_number: emp.employee_number,
      name: `${emp.first_name} ${emp.last_name}`,
      email: emp.email || "—",
      department: emp.department_name || emp.department || "—",
      position: positionName((emp as any).job_position_id, activePositions) || emp.position || "—",
      status: emp.is_active ? "Active" : "Inactive",
      hire_date: format(new Date(emp.hire_date), "MMM d, yyyy"),
      basic_salary: emp.basic_salary,
    })),
    organizationId: currentOrg?.id,
    currency: currentBusiness?.base_currency || undefined,
  } as ExportConfig);

  const renderRowActions = (emp: Employee) => {
    const isOwner = !!emp.user_id && emp.user_id === (currentOrg as any)?.owner_user_id;
    return (
      <RowActions
        employee={emp}
        canManage={can("manageEmployees")}
        isOwner={isOwner}
        onView={() => navigate(`/hr/employees/${emp.id}`)}
        onEdit={() => handleOpenDialog(emp)}
        onInvite={() => setInviteDialogEmployee(emp)}
        onLink={() => setLinkDialogEmployee(emp)}
        onSetManager={() => setManagerDialogEmployee(emp)}
        onTransfer={() => setTransferEmployee(emp)}
        onChangeComp={() => setCompensationEmployee(emp)}
        onToggleStatus={() => handleToggleStatus(emp)}
        onTerminate={() => setTerminatingEmployee(emp)}
        onDelete={() => deleteConfirm.requestDelete(emp)}
      />
    );
  };

  // Resolve ids for the current filter set (used by "Select all matching"
  // and bulk operations that want every match, not just the loaded page).
  const fetchAllMatchingIds = useCallback(async (): Promise<string[]> => {
    if (!currentOrg?.id || !currentBusiness?.id) return [];
    const { data, error } = await supabase.rpc("list_employee_ids_matching" as any, {
      p_org_id: currentOrg.id,
      p_business_id: currentBusiness.id,
      p_branch_ids: null,
      p_search: searchQuery?.trim() || null,
      p_status: statusFilter,
      p_department_id: deptFilter === "all" ? null : deptFilter,
      p_position_id: positionFilter === "all" ? null : positionFilter,
      p_location_id: locationFilter === "all" ? null : locationFilter,
      p_health: healthFilter === "all" ? null : healthFilter,
    });
    if (error) {
      toast({ title: "Could not resolve matching employees", description: normalizeError(error).message, variant: "destructive" });
      return [];
    }
    return (data as string[]) ?? [];
  }, [currentOrg?.id, currentBusiness?.id, searchQuery, statusFilter, deptFilter, positionFilter, locationFilter, healthFilter, toast]);

  const handleSelectAllMatching = async () => {
    const ids = await fetchAllMatchingIds();
    selection.setAll(ids, true);
    toast({ title: `Selected ${ids.length} employee${ids.length === 1 ? "" : "s"} matching filters` });
  };

  const handleBulkSetStatus = async (active: boolean) => {
    const ids = Array.from(selection.selectedIds);
    if (ids.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    let ok = 0;
    let failed = 0;
    const empsById = new Map<string, DirectoryEmployee>((employees as DirectoryEmployee[]).map((e) => [e.id, e]));
    for (const id of ids) {
      const emp = empsById.get(id);
      try {
        if (!active) {
          const { error } = await supabase.rpc("terminate_employee" as any, {
            p_employee_id: id,
            p_end_date: today,
            p_type: "other",
            p_reason: "Bulk deactivation",
            p_exit_data: {},
          });
          if (error) throw error;
        } else {
          const { error } = await supabase.rpc("rehire_employee" as any, {
            p_employee_id: id,
            p_start_date: today,
            p_employment_type: emp?.employment_type ?? "full_time",
            p_business_id: (emp as any)?.business_id ?? null,
            p_branch_id: (emp as any)?.branch_id ?? null,
          });
          if (error) throw error;
        }
        ok++;
      } catch {
        failed++;
      }
    }

    if (failed > 0) {
      toast({ title: `${ok} updated, ${failed} failed`, variant: failed === ids.length ? "destructive" : "default" });
    } else {
      toast({ title: `${ok} employee${ok === 1 ? "" : "s"} ${active ? "activated" : "deactivated"}` });
    }
    selection.clear();
    await refreshEmployees();
  };

  const handleBulkAssign = async (field: "department_id" | "work_location_id", value: string | null) => {
    const ids = Array.from(selection.selectedIds);
    if (ids.length === 0) return;
    const { error, count } = await supabase
      .from("employees")
      .update({ [field]: value } as any, { count: "exact" })
      .in("id", ids)
      .eq("organization_id", currentOrg!.id);
    if (error) {
      toast({ title: "Bulk update failed", description: normalizeError(error).message, variant: "destructive" });
    } else {
      toast({ title: `${count ?? ids.length} employee${(count ?? ids.length) === 1 ? "" : "s"} updated` });
    }
    selection.clear();
    await refreshEmployees();
  };

  return (
    <>
      <PageHeader
        eyebrow="HR · People"
        title="Employees"
        description="Directory of people in this company."
        actions={
          <>
            <CustomizeFieldsButton entityType="employee" />
            {can("manageEmployees") && (
              <>
                <ChangeRequestsBadgeButton />
                <Button variant="outline" onClick={() => navigate("/hr/configuration")}>
                  HR Workspace Setup
                </Button>
                <Button variant="outline" onClick={() => setShowImportWizard(true)}>
                  <Upload className="mr-2 h-4 w-4" /> Import
                </Button>
                <PermissionGate permission="manageEmployees">
                  <div className="flex">
                    <Button
                      onClick={() => {
                        if (isReadOnly) return openUpgradeModal("employees");
                        navigate("/hr/employees/new");
                      }}
                      className="rounded-r-none"
                    >
                      <Plus className="mr-2 h-4 w-4" /> Add Employee
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          className="rounded-l-none border-l border-primary-foreground/20 px-2"
                          aria-label="More add-employee options"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuLabel>Add an employee</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => {
                          if (isReadOnly) return openUpgradeModal("employees");
                          navigate("/hr/employees/new");
                        }}>
                          <Plus className="h-4 w-4 mr-2" />
                          Full form (recommended)
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleOpenDialog()}>
                          <Zap className="h-4 w-4 mr-2" />
                          Quick add (modal)
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setShowImportWizard(true)}>
                          <Upload className="h-4 w-4 mr-2" />
                          Import from CSV…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </PermissionGate>
              </>
            )}
          </>
        }
      />
      <PageBody fullWidth className="gap-4 sm:gap-6">



        <div className={`stats-grid grid-cols-1 sm:grid-cols-2 ${can("viewPayroll") ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
          <StatCard
            label="Total"
            value={stats.total.toString()}
            icon={Users}
            accent="amber"
            description={`${stats.active} active · ${stats.inactive} inactive`}
          />
          <StatCard
            label="Active"
            value={stats.active.toString()}
            icon={UserCheck}
            accent="blue"
          />
          <StatCard
            label="Inactive"
            value={stats.inactive.toString()}
            icon={UserX}
            accent="purple"
          />
          <StatCard
            label="Needs attention"
            value={needsAttentionCount.toString()}
            icon={AlertTriangle}
            accent="rose"
          />
          {can("viewPayroll") && (
            <StatCard
              label="Monthly Payroll"
              value={formatCurrency(totalPayroll)}
              icon={Briefcase}
              accent="emerald"
              description="gross monthly total"
            />
          )}
        </div>

        <div className="filter-bar flex flex-col lg:flex-row gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search employees..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-10 w-full"
            />
          </div>
          <FilterSelect value={statusFilter} onChange={(v) => setStatusFilter(v as any)} options={[
            { v: "all", l: "All Status" },
            { v: "active", l: "Active" },
            { v: "inactive", l: "Inactive" },
            { v: "drafts", l: "Drafts" },
          ]} width="w-full sm:w-36" />

          <FilterSelect value={deptFilter} onChange={setDeptFilter} options={[
            { v: "all", l: "All Departments" },
            ...activeDepartments.map((d) => ({ v: d.id, l: d.name })),
          ]} width="w-full sm:w-44" />
          <FilterSelect value={positionFilter} onChange={setPositionFilter} options={[
            { v: "all", l: "All Positions" },
            ...activePositions.map((p) => ({ v: p.id, l: p.name })),
          ]} width="w-full sm:w-44" />
          <FilterSelect value={locationFilter} onChange={setLocationFilter} options={[
            { v: "all", l: "All Locations" },
            ...activeLocations.map((l) => ({ v: l.id, l: l.name })),
          ]} width="w-full sm:w-44" />
          <FilterSelect value={healthFilter} onChange={(v) => setHealthFilter(v as any)} options={[
            { v: "all", l: "All Health" },
            { v: "ready", l: "Ready" },
            { v: "incomplete", l: "Incomplete" },
            { v: "blocked", l: "Blocked" },
            { v: "inactive", l: "Inactive" },
          ]} width="w-full sm:w-40" />

          <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v as any)} className="hidden md:flex">
            <ToggleGroupItem value="table" aria-label="Table view"><ListIcon className="h-4 w-4" /></ToggleGroupItem>
            <ToggleGroupItem value="cards" aria-label="Card view"><LayoutGrid className="h-4 w-4" /></ToggleGroupItem>
          </ToggleGroup>
          <ReportExportButtons getExportConfig={exportConfig} formats={["excel", "csv", "pdf"]} compact />
        </div>

        <BulkActionBar
          count={selection.count}
          canManage={can("manageEmployees")}
          actions={{
            onSetManager: () => {
              const first = filteredEmployees.find((e) => selection.selectedIds.has(e.id));
              if (first) setManagerDialogEmployee(first);
            },
            onSetDepartment: () => setBulkDept(true),
            onSetWorkLocation: () => setBulkLoc(true),
            onActivate: () => handleBulkSetStatus(true),
            onDeactivate: () => handleBulkSetStatus(false),
            onClear: selection.clear,
          }}
        />

        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span>
            Showing {filteredEmployees.length} of {stats.total}
            {hasNextPage ? " (more available)" : ""}
          </span>
          {stats.total > filteredEmployees.length && (
            <button
              type="button"
              onClick={handleSelectAllMatching}
              className="underline hover:text-foreground"
            >
              Select all {stats.total} matching
            </button>
          )}
        </div>

        <Card>
          <CardContent className="p-0">
            {(isLoading || !currencyReady) ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredEmployees.length === 0 ? (
              <EmptyState totalEmployees={stats.total} />
            ) : view === "cards" ? (
              <CardGrid
                employees={filteredEmployees}
                positions={activePositions}
                locations={activeLocations}
                onOpen={(e) => setQuickViewEmployee(e)}
                rowActions={renderRowActions}
                selectedIds={selection.selectedIds}
                onToggleSelected={selection.toggle}
                healthById={healthById}
              />
            ) : (
              <DesktopTable
                employees={filteredEmployees}
                positions={activePositions}
                locations={activeLocations}
                canViewPayroll={can("viewPayroll")}
                formatCurrency={formatCurrency}
                calculateGrossPay={calculateGrossPay}
                onOpen={(e) => setQuickViewEmployee(e)}
                rowActions={renderRowActions}
                selectedIds={selection.selectedIds}
                onToggleSelected={selection.toggle}
                onToggleAll={(checked) => selection.setAll(filteredEmployees.map((e) => e.id), checked)}
                healthById={healthById}
              />
            )}
            {hasNextPage && (
              <div ref={sentinelRef} className="flex items-center justify-center py-6">
                {isFetchingNextPage ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => fetchNextPage()}>
                    Load more
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <EmployeeDirectoryDialogs
          showForm={showDialog} setShowForm={setShowDialog}
          editingEmployee={editingEmployee} onSubmit={handleSubmit}
          linkDialogEmployee={linkDialogEmployee} setLinkDialogEmployee={setLinkDialogEmployee}
          managerDialogEmployee={managerDialogEmployee} setManagerDialogEmployee={setManagerDialogEmployee}
          inviteDialogEmployee={inviteDialogEmployee} setInviteDialogEmployee={setInviteDialogEmployee}
          deleteConfirm={deleteConfirm}
          showImportWizard={showImportWizard} setShowImportWizard={setShowImportWizard}
          onImportEmployee={handleImportEmployee}
          importFieldDefinitions={dynamicImportFields}
          terminatingEmployee={terminatingEmployee} setTerminatingEmployee={setTerminatingEmployee}
          onTerminate={handleTerminate}
          transferEmployee={transferEmployee} setTransferEmployee={setTransferEmployee}
          compensationEmployee={compensationEmployee} setCompensationEmployee={setCompensationEmployee}
          refreshEmployees={refreshEmployees}
        />

        <BulkAssignDialog
          open={bulkDept}
          onOpenChange={setBulkDept}
          title="Set department"
          label="Department"
          options={activeDepartments.map((d) => ({ id: d.id, name: d.name }))}
          count={selection.count}
          onApply={(v) => handleBulkAssign("department_id", v)}
        />
        <BulkAssignDialog
          open={bulkLoc}
          onOpenChange={setBulkLoc}
          title="Set work location"
          label="Work location"
          options={activeLocations.map((l) => ({ id: l.id, name: l.name }))}
          count={selection.count}
          onApply={(v) => handleBulkAssign("work_location_id", v)}
        />

        <EmployeeQuickViewSheet
          employee={quickViewEmployee}
          open={!!quickViewEmployee}
          onOpenChange={(open) => !open && setQuickViewEmployee(null)}
        />
      </PageBody>
    </>
  );
}

// ---------------------------------------------------------------------------
// ChangeRequestsBadgeButton — link into the HR profile-change review queue
// with a live pending-count badge. Uses head-only count so it is cheap.
// ---------------------------------------------------------------------------

function ChangeRequestsBadgeButton() {
  const nav = useNavigate();
  const { data: count } = useChangeRequestsCount();

  return (
    <Button
      variant="outline"
      onClick={() => nav("/hr/employees/change-requests")}
      className="relative"
    >
      <ChangeRequestBell className="mr-2 h-4 w-4" />
      Change requests
      {count && count > 0 ? (
        <ChangeRequestBadge variant="destructive" className="ml-2 h-5 px-1.5 text-[10px]">
          {count}
        </ChangeRequestBadge>
      ) : null}
    </Button>
  );
}
