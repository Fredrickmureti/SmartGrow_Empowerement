/**
 * Recruitment Sub-App Routes (Turn H).
 * Mounts at /hr/recruitment/*.
 */
import { lazy } from "react";
import { Routes, Route } from "react-router-dom";
import { PermissionProtectedRoute } from "@/components/auth/PermissionProtectedRoute";
import { EMPLOYEES_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { RECRUITMENT_NAV } from "../shared/navs";
import { LazyRoute } from "../shared/guards";

const Recruitment = lazy(() => import("@/pages/hr/Recruitment"));

export default function RecruitmentApp() {
  return (
    <PlatformShell app={EMPLOYEES_APP} nav={RECRUITMENT_NAV}>
      <Routes>
        <Route
          path="*"
          element={
            <PermissionProtectedRoute permission="manageEmployees" fallbackPath="/hr/dashboard">
              <LazyRoute module="Recruitment">
                <Recruitment />
              </LazyRoute>
            </PermissionProtectedRoute>
          }
        />
      </Routes>
    </PlatformShell>
  );
}

