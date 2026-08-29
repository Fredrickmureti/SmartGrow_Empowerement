/**
 * My Workspace App (`/me/*`)
 *
 * Employee self-service shell. Available to ANY authenticated user who is
 * linked to an `employees` row, regardless of which apps the organization
 * has installed.
 *
 * Scope for the microfinance platform: identity, profile, documents,
 * onboarding checklist and notifications. Leave, attendance, shifts,
 * payroll (payslips, loans, earnings), talent, learning and 1:1s are not
 * part of the scoped product and their self-service surfaces were removed
 * together with the admin modules that fed them.
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { MePortalLayout } from "@/components/me/MePortalLayout";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SelfServiceProvider } from "@/contexts/SelfServiceContext";

const MeHome = lazy(() => import("@/pages/me/MeHome"));
const MyProfile = lazy(() => import("@/pages/me/MyProfilePage"));
const MyAccount = lazy(() => import("@/pages/me/MyAccount"));
const MyNotifications = lazy(() => import("@/pages/me/MyNotifications"));
const MyOnboarding = lazy(() => import("@/pages/me/MyOnboarding"));
const MyDocuments = lazy(() => import("@/pages/me/MyDocuments"));
const MySettings = lazy(() => import("@/pages/me/MySettings"));
const MyTeamPage = lazy(() => import("@/pages/me/MyTeamPage"));

const Lazy = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>{children}</Suspense>
);

export default function MeApp() {
  return (
    <SelfServiceProvider>
      <MePortalLayout>
        <Routes>
          {/* Default landing — friendly dashboard with quick actions */}
          <Route index element={<Lazy module="My Workspace"><MeHome /></Lazy>} />

          {/* My Profile — redirects to the linked HR employee profile if any. */}
          <Route path="profile" element={<Lazy module="My Profile"><MyProfile /></Lazy>} />

          {/* My Documents — portal page with acknowledgement */}
          <Route path="documents" element={<Lazy module="My Documents"><MyDocuments /></Lazy>} />

          {/* My Onboarding — checklist for new hires */}
          <Route path="onboarding" element={<Lazy module="My Onboarding"><MyOnboarding /></Lazy>} />

          {/* My Account — identity, password, preferences. */}
          <Route path="account" element={<Lazy module="My Account"><MyAccount /></Lazy>} />
          <Route path="settings" element={<Lazy module="My Settings"><MySettings /></Lazy>} />
          <Route
            path="notifications"
            element={<Lazy module="Notifications"><MyNotifications /></Lazy>}
          />

          <Route path="team" element={<Lazy module="My Team"><MyTeamPage /></Lazy>} />

          {/* Catch-all: send back to the workspace landing */}
          <Route path="*" element={<Navigate to="/me" replace />} />
        </Routes>
      </MePortalLayout>
    </SelfServiceProvider>
  );
}
