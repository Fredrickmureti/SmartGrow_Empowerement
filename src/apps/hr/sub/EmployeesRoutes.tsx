/**
 * Employees Sub-App Routes (Odoo `hr` foundation)
 *
 * Owns: dashboard, employee directory, employee profile, HR configuration,
 * and people analytics that live on the Employees overview.
 *
 * **Boundary**: Departments, Job positions, Work locations and the Org
 * chart are built-in Employees surfaces and live under
 * `/hr/employees/*`. Reports are owned by the HR Reports workspace
 * (`/hr/reports/*`). Talent (performance, goals, reviews, competencies,
 * development, learning) lives under `/hr/talent/*`.
 *
 * There is no redirect/alias layer: every surface has exactly one URL and
 * every link in the app points at it directly.
 *
 * Mounted at /hr/* — the HR dispatcher delegates these path segments here.
 */

import { lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { InstitutionRoute } from "@/components/auth/InstitutionRoute";
import { PermissionProtectedRoute } from "@/components/auth/PermissionProtectedRoute";
import { OwnProfileOrPermissionRoute } from "@/components/auth/OwnProfileOrPermissionRoute";
import { EMPLOYEES_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { EMPLOYEES_NAV } from "../shared/navs";
import { HRCatchAllRedirect, LazyRoute } from "../shared/guards";

const Employees = lazy(() => import("@/pages/Employees"));
const HRDashboard = lazy(() => import("@/pages/hr/HRDashboard"));
const EmployeeProfile = lazy(() => import("@/pages/hr/EmployeeProfile"));
const EmployeeNewPage = lazy(() => import("@/pages/hr/EmployeeNewPage"));
const MyDraftsPage = lazy(() => import("@/pages/hr/MyDraftsPage"));
const EmployeeChangeRequestsPage = lazy(() => import("@/pages/hr/EmployeeChangeRequestsPage"));
const EmployeesConfiguration = lazy(() => import("@/pages/hr/configuration/ConfigurationLayout"));
const OnboardingIssues = lazy(() => import("@/pages/hr/OnboardingIssues"));
const Departments = lazy(() => import("@/pages/Departments"));
const DepartmentCreatePage = lazy(() => import("@/features/hr/departments/DepartmentCreatePage"));
const DepartmentEditPage = lazy(() => import("@/features/hr/departments/DepartmentEditPage"));
const JobPositions = lazy(() => import("@/pages/hr/JobPositions"));
const JobPositionCreatePage = lazy(() => import("@/features/hr/positions/JobPositionCreatePage"));
const JobPositionEditPage = lazy(() => import("@/features/hr/positions/JobPositionEditPage"));
const WorkLocations = lazy(() => import("@/pages/hr/WorkLocations"));
const WorkLocationCreatePage = lazy(() => import("@/features/hr/locations/WorkLocationCreatePage"));
const WorkLocationEditPage = lazy(() => import("@/features/hr/locations/WorkLocationEditPage"));
const OrgChart = lazy(() => import("@/pages/hr/OrgChart"));

export function EmployeesApp() {
  return (
    <PlatformShell app={EMPLOYEES_APP} nav={EMPLOYEES_NAV}>
      <Routes>
        <Route index element={<Navigate to="dashboard" replace />} />

        <Route
          path="dashboard"
          element={
            <LazyRoute module="HR Dashboard">
              <HRDashboard />
            </LazyRoute>
          }
        />

        <Route
          path="employees"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="Employees">
                <Employees />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* Full-page Add Employee — the Odoo-grade form view. Lives at a
            stable URL so deep links, browser back, and refresh all behave. */}
        <Route
          path="employees/new"
          element={
            <InstitutionRoute>
              <PermissionProtectedRoute permission="manageEmployees" fallbackPath="/hr/employees">
                <LazyRoute module="Add Employee">
                  <EmployeeNewPage />
                </LazyRoute>
              </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />

        {/* "My drafts" — current user's in-progress employee records. */}
        <Route
          path="employees/drafts/mine"
          element={
            <InstitutionRoute allowReadOnly>
              <LazyRoute module="My Drafts">
                <MyDraftsPage />
              </LazyRoute>
            </InstitutionRoute>
          }
        />

        {/* HR review queue for employee-submitted profile change requests.
            Static segment ranks above `employees/:id` in RRv6, so this is safe. */}
        <Route
          path="employees/change-requests"
          element={
            <PermissionProtectedRoute permission="manageEmployees" fallbackPath="/hr/employees">
              <LazyRoute module="Profile change requests">
                <EmployeeChangeRequestsPage />
              </LazyRoute>
            </PermissionProtectedRoute>
          }
        />

        <Route
          path="employees/:id"
          element={
            <InstitutionRoute allowReadOnly>
              <OwnProfileOrPermissionRoute permission="viewEmployees" fallbackPath="/me">
                <LazyRoute module="Employee Profile">
                  <EmployeeProfile />
                </LazyRoute>
              </OwnProfileOrPermissionRoute>
            </InstitutionRoute>
          }
        />

        {/* Departments, Job positions, Work locations and the Org chart
            are built-in features of the Employees app (Odoo `hr` pattern).
            They live under /hr/employees/* and render inside this shell —
            no separate "Org" workspace.

            IMPORTANT: these MUST be mounted under `employees/...`, not at
            the sub-app root, and every `employees/<segment>` surface must be
            declared here. Any undeclared segment is captured by the sibling
            `employees/:id` route as an employee UUID — producing spurious
            `v_employees_safe?id=eq.departments` lookups and the
            "Employee Not Found" placeholder. React Router v6 ranks
            static segments above dynamic, so these win over `:id`. */}
        <Route
          path="employees/departments/new"
          element={
            <PermissionProtectedRoute permission="manageDepartments" fallbackPath="/hr/employees/departments">
              <LazyRoute module="New Department">
                <DepartmentCreatePage />
              </LazyRoute>
            </PermissionProtectedRoute>
          }
        />
        <Route
          path="employees/departments/:id/edit"
          element={
            <PermissionProtectedRoute permission="manageDepartments" fallbackPath="/hr/employees/departments">
              <LazyRoute module="Edit Department">
                <DepartmentEditPage />
              </LazyRoute>
            </PermissionProtectedRoute>
          }
        />
        <Route
          path="employees/departments/*"
          element={
            <LazyRoute module="Departments">
              <Departments />
            </LazyRoute>
          }
        />
        <Route
          path="employees/positions/new"
          element={
            <PermissionProtectedRoute permission="manageJobPositions" fallbackPath="/hr/employees/positions">
              <LazyRoute module="New Job Position">
                <JobPositionCreatePage />
              </LazyRoute>
            </PermissionProtectedRoute>
          }
        />
        <Route
          path="employees/positions/:id/edit"
          element={
            <PermissionProtectedRoute permission="manageJobPositions" fallbackPath="/hr/employees/positions">
              <LazyRoute module="Edit Job Position">
                <JobPositionEditPage />
              </LazyRoute>
            </PermissionProtectedRoute>
          }
        />
        <Route
          path="employees/positions/*"
          element={
            <LazyRoute module="Job positions">
              <JobPositions />
            </LazyRoute>
          }
        />
        <Route
          path="employees/locations/new"
          element={
            <PermissionProtectedRoute permission="manageWorkLocations" fallbackPath="/hr/employees/locations">
              <LazyRoute module="New Work Location">
                <WorkLocationCreatePage />
              </LazyRoute>
            </PermissionProtectedRoute>
          }
        />
        <Route
          path="employees/locations/:id/edit"
          element={
            <PermissionProtectedRoute permission="manageWorkLocations" fallbackPath="/hr/employees/locations">
              <LazyRoute module="Edit Work Location">
                <WorkLocationEditPage />
              </LazyRoute>
            </PermissionProtectedRoute>
          }
        />
        <Route
          path="employees/locations/*"
          element={
            <LazyRoute module="Work locations">
              <WorkLocations />
            </LazyRoute>
          }
        />
        <Route
          path="employees/org-chart"
          element={
            <LazyRoute module="Org chart">
              <OrgChart />
            </LazyRoute>
          }
        />

        <Route
          path="configuration/*"
          element={
            <PermissionProtectedRoute permission="manageEmployees" fallbackPath="/hr/dashboard">
              <LazyRoute module="HR Configuration">
                <EmployeesConfiguration />
              </LazyRoute>
            </PermissionProtectedRoute>
          }
        />

        {/* `/hr/reports` is owned by the HR Reports workspace (dispatcher mounts
            HrReportsApp at `reports/*`). No in-shell route here. */}

        <Route
          path="onboarding-issues"
          element={
            <PermissionProtectedRoute permission="manageEmployees" fallbackPath="/hr/dashboard">
              <LazyRoute module="Onboarding Issues">
                <OnboardingIssues />
              </LazyRoute>
            </PermissionProtectedRoute>
          }
        />

        <Route path="*" element={<HRCatchAllRedirect />} />
      </Routes>
    </PlatformShell>
  );
}

export default EmployeesApp;
