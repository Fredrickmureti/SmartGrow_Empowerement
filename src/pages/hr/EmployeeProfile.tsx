/**
 * Employee Profile Hub — Wave G IA tightening.
 *
 * Sidebar reduced from 17 → 12 items:
 *  - Loans + Benefits + Assets → single "Benefits & assets" section with tabs
 *  - Compensation history → tab inside Contracts
 *  - HR Settings → header overflow menu (no longer a sidebar item)
 *
 * Legacy `?section=loans|assets|compensation|hr_settings` URLs are
 * normalized via `LEGACY_SECTION_REDIRECTS` so deep links from emails,
 * automations, and dashboards keep working.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Loader2, User, Briefcase, Lock, Calendar, FileText, DollarSign,
  ClipboardList, ScrollText, History, Clock, Timer,
  Package, LogOut,
} from "lucide-react";


import { useEmployeeProfile } from "@/hooks/useEmployeeProfile";
import { usePermissions } from "@/hooks/usePermissions";
import { useAuth } from "@/contexts/AuthContext";

import { EmployeeProfileHeader } from "@/components/employees/EmployeeProfileHeader";
import { EmployeeWorkInfo } from "@/components/employees/EmployeeWorkInfo";
import { EmployeePrivateInfo } from "@/components/employees/EmployeePrivateInfo";
import { EmployeeHRSettings } from "@/components/employees/EmployeeHRSettings";
import { EmployeeLeaveSummary } from "@/components/employees/EmployeeLeaveSummary";
import { EmployeePayslipHistory } from "@/components/employees/EmployeePayslipHistory";
import { EmployeePayrollInfo } from "@/components/employees/EmployeePayrollInfo";
import { EmployeeCustomDeductionsSection } from "@/components/payroll/EmployeeCustomDeductionsSection";
import { EmployeeDraftBanner } from "@/components/employees/EmployeeDraftBanner";
import { EmployeeReadinessPanel } from "@/components/payroll/EmployeeReadinessPanel";
import { EmployeeDocumentsTab } from "@/components/employees/EmployeeDocumentsTab";
import { EmployeeOnboardingTab } from "@/components/employees/EmployeeOnboardingTab";
import { EmployeeHistoryTimeline } from "@/components/employees/EmployeeHistoryTimeline";
import { EmployeeAttendanceSummary } from "@/components/employees/EmployeeAttendanceSummary";
import { EmployeeTimesheetSummary } from "@/components/employees/EmployeeTimesheetSummary";
import { EmployeeExitClearanceTab } from "@/components/employees/EmployeeExitClearanceTab";

import { ProfileSidebar, type ProfileSection } from "@/components/employees/profile/ProfileSidebar";
import { OverviewSection } from "@/components/employees/profile/OverviewSection";
import { BenefitsAndAssetsSection, type BenefitsTab } from "@/components/employees/profile/BenefitsAndAssetsSection";
import { ContractsSection, type ContractsTab } from "@/components/employees/profile/ContractsSection";
import { LEGACY_SECTION_REDIRECTS, CANONICAL_SECTIONS } from "@/lib/hr/legacyProfileSections";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { WorkflowSheet } from "@/components/workflow/WorkflowSheet";

const SELF_SERVICE_FIELDS = new Set([
  "avatar_url",
  "first_name",
  "last_name",
  "emergency_contact_name",
  "emergency_contact_phone",
  "personal_phone",
  "phone",
  "date_of_birth",
]);

export default function EmployeeProfilePage() {
  const { id } = useParams<{ id: string }>();
  // Diagnostic: if the route param is not a UUID, a parent route or a
  // misaimed redirect has fallen through to `employees/:id`. Surface that
  // loudly instead of issuing a guaranteed-empty `v_employees_safe?id=eq.<segment>`
  // query and rendering a misleading "Employee Not Found" placeholder.
  // See HR Stabilization plan, Regression 1.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (id && !UUID_RE.test(id)) {
    throw new Error(
      `EmployeeProfile mounted with non-UUID :id="${id}". A route or redirect is leaking a path segment into the dynamic employee route. Fix the routing, do not add a guard here.`,
    );
  }
  const { employee, isLoading, updateEmployee, refreshEmployee } = useEmployeeProfile(id);
  const { canManageTeam, can } = usePermissions();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [hrSettingsOpen, setHrSettingsOpen] = useState(false);

  const isOwnProfile = employee?.user_id === user?.id;
  const canEdit = canManageTeam || isOwnProfile;
  const canViewPrivate = isOwnProfile || can("viewEmployeePrivate");
  const canViewEmpPayroll = can("viewEmployeePayroll") || isOwnProfile;
  const canViewPayrollRuns = can("viewPayroll");

  // 12 canonical sections — see lib/hr/legacyProfileSections.ts
  const sections: ProfileSection[] = useMemo(() => [
    { id: "overview",    label: "Overview",            icon: User,          group: "main",  visible: true },
    { id: "work",        label: "Work Information",    icon: Briefcase,     group: "main",  visible: true },
    { id: "private",     label: "Private Information", icon: Lock,          group: "main",  visible: canViewPrivate },
    { id: "contracts",   label: "Contracts",           icon: ScrollText,    group: "hr",    visible: canManageTeam || isOwnProfile },
    { id: "leave",       label: "Time Off",            icon: Calendar,      group: "hr",    visible: true },
    { id: "attendance",  label: "Attendance",          icon: Clock,         group: "hr",    visible: true },
    { id: "timesheets",  label: "Timesheets",          icon: Timer,         group: "hr",    visible: true },
    { id: "payroll",     label: "Payroll",             icon: DollarSign,    group: "hr",    visible: canViewEmpPayroll || canViewPayrollRuns },
    { id: "benefits",    label: "Benefits & assets",   icon: Package,       group: "hr",    visible: canManageTeam || isOwnProfile },
    { id: "documents",   label: "Documents",           icon: FileText,      group: "hr",    visible: true },
    { id: "onboarding",  label: "Onboarding",          icon: ClipboardList, group: "admin", visible: canManageTeam },
    { id: "exit",        label: "Exit Clearance",      icon: LogOut,        group: "admin", visible: canManageTeam },
    { id: "history",     label: "Activity Log",        icon: History,       group: "admin", visible: canManageTeam },
  ], [canViewPrivate, canViewEmpPayroll, canViewPayrollRuns, canManageTeam, isOwnProfile]);

  const requestedSection = searchParams.get("section") || "overview";
  const requestedTab = searchParams.get("tab") || "";

  // Resolve legacy sidebar keys to the new (section, tab) pair before
  // picking the active section.
  const resolved = useMemo(() => {
    const redirect = LEGACY_SECTION_REDIRECTS[requestedSection];
    if (redirect) return { section: redirect.section, tab: redirect.tab ?? requestedTab };
    return { section: requestedSection, tab: requestedTab };
  }, [requestedSection, requestedTab]);

  const active = sections.find((s) => s.id === resolved.section && s.visible)?.id || "overview";

  // If we redirected (or the requested section is hidden), normalize the
  // URL so refreshes + history land on the canonical key.
  useEffect(() => {
    if (active === resolved.section && requestedSection === active) return;
    const next = new URLSearchParams(searchParams);
    next.set("section", active);
    if (resolved.tab) next.set("tab", resolved.tab); else next.delete("tab");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, resolved.section, resolved.tab]);

  const onSelectSection = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("section", id);
    next.delete("tab");
    setSearchParams(next, { replace: true });
  };

  const onSelectTab = (tab: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next, { replace: true });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!employee) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center px-4">
        <User className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-lg font-semibold">Employee Not Found</h2>
        <p className="text-muted-foreground text-sm mt-2">
          This employee record could not be found or you don't have access.
        </p>
      </div>
    );
  }

  const handleSelfServiceUpdate = (updates: Partial<typeof employee>) => {
    if (canManageTeam) return updateEmployee(updates);
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (SELF_SERVICE_FIELDS.has(key)) filtered[key] = value;
    }
    if (Object.keys(filtered).length === 0) return;
    return updateEmployee(filtered);
  };

  const getEmployeeExportConfig = (): ExportConfig => ({
    title: "Employee Profile",
    subtitle: `${employee.first_name} ${employee.last_name} (${employee.employee_number})`,
    columns: [
      { key: "field", header: "Field", width: 25 },
      { key: "value", header: "Value", width: 35 },
    ],
    rows: [
      { field: "Employee #", value: employee.employee_number },
      { field: "Name", value: `${employee.first_name} ${employee.last_name}` },
      { field: "Email", value: employee.email || "—" },
      { field: "Position", value: employee.position || "—" },
      { field: "Department", value: employee.department_name || employee.department || "—" },
      { field: "Employment Type", value: employee.employment_type || "—" },
      { field: "Hire Date", value: employee.hire_date || "—" },
      { field: "Status", value: employee.is_active ? "Active" : "Inactive" },
    ],
    sheetName: "Employee",
  });

  const contractsTab: ContractsTab = resolved.tab === "history" ? "history" : "info";
  const benefitsTab: BenefitsTab =
    resolved.tab === "loans" ? "loans" :
    resolved.tab === "assets" ? "assets" : "benefits";

  return (
    <div className="space-y-4">
      {employee.lifecycle_status === "draft" && (
        <EmployeeDraftBanner
          employeeId={employee.id}
          canPromote={canManageTeam}
          onPromoted={refreshEmployee}
        />
      )}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <EmployeeProfileHeader
          employee={employee}
          canEdit={canEdit}
          onAvatarChange={(url) => handleSelfServiceUpdate({ avatar_url: url })}
          onOpenHrSettings={canManageTeam ? () => setHrSettingsOpen(true) : undefined}
        />
        <ReportExportButtons getExportConfig={getEmployeeExportConfig} compact />
      </div>


      <div className="flex flex-col md:flex-row gap-4 md:gap-6">
        <ProfileSidebar sections={sections} active={active} onSelect={onSelectSection} />

        <div className="flex-1 min-w-0">
          {active === "overview" && (
            <OverviewSection employee={employee} onNavigateSection={onSelectSection} />
          )}
          {active === "work" && <EmployeeWorkInfo employee={employee} />}
          {active === "private" && canViewPrivate && (
            <EmployeePrivateInfo employee={employee} />
          )}
          {active === "contracts" && (
            <ContractsSection
              employeeId={employee.id}
              canEdit={canManageTeam}
              tab={contractsTab}
              onTabChange={onSelectTab}
            />
          )}
          {active === "leave" && <EmployeeLeaveSummary employeeId={employee.id} />}
          {active === "attendance" && <EmployeeAttendanceSummary employeeId={employee.id} />}
          {active === "timesheets" && <EmployeeTimesheetSummary employeeId={employee.id} />}
          {active === "payroll" && (
            <PayrollSectionTabs
              employee={employee}
              canViewPayrollRuns={canViewPayrollRuns}
              canViewEmpPayroll={canViewEmpPayroll}
            />
          )}
          {active === "benefits" && (
            <BenefitsAndAssetsSection
              employeeId={employee.id}
              canEdit={canManageTeam}
              tab={benefitsTab}
              onTabChange={onSelectTab}
            />
          )}
          {active === "documents" && (
            <EmployeeDocumentsTab employeeId={employee.id} canEdit={canManageTeam} />
          )}
          {active === "onboarding" && canManageTeam && (
            <EmployeeOnboardingTab employeeId={employee.id} canEdit={canManageTeam} />
          )}
          {active === "exit" && canManageTeam && (
            <EmployeeExitClearanceTab employeeId={employee.id} />
          )}
          {active === "history" && canManageTeam && (
            <EmployeeHistoryTimeline employeeId={employee.id} />
          )}
        </div>
      </div>

      {/* HR Settings: header overflow menu opens this dialog. Keeps a
          rarely-used configuration surface off the primary nav while
          remaining one click away for admins. */}
      <WorkflowSheet
        open={hrSettingsOpen}
        onOpenChange={setHrSettingsOpen}
        size="xl"
        title="HR Settings"
        description="Workforce policies, identifiers and admin overrides for this employee."
      >
        {canManageTeam && (
          <EmployeeHRSettings employee={employee} onRefresh={refreshEmployee} />
        )}
      </WorkflowSheet>

    </div>
  );
}

// Re-export the canonical section list so tests can import it without
// duplicating the source of truth.
export { CANONICAL_SECTIONS };
