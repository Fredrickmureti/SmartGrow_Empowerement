/**
 * My Workspace App (`/me/*`)
 *
 * Employee self-service shell. Available to ANY authenticated user who is
 * linked to an `employees` row, regardless of which HR-domain apps the
 * organization has installed.
 *
 * Self-service is a portal capability gated by employment, NOT a paid app.
 * Admins still see this — it shows their own employee record in addition to
 * the HR admin apps they may have access to.
 *
 * Replaces the legacy `/hr/my-portal`, `/hr/my-profile`, `/hr/timesheets` (own),
 * and `/hr/documents` (own) routes — those redirect here for back-compat.
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { MePortalLayout } from "@/components/me/MePortalLayout";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SelfServiceProvider } from "@/contexts/SelfServiceContext";
import { AppInstalledGate } from "@/components/apps/AppInstalledGate";


// New /me landing dashboard (replaces the legacy EmployeeSelfService as the index).
const MeHome = lazy(() => import("@/pages/me/MeHome"));
// Purpose-built portal payslip page. The legacy EmployeeSelfService is no
// longer mounted under /me/* — it carried admin-flavoured affordances
// (e.g. "Add me as an employee") that leaked to regular portal users.
const MyPayslips = lazy(() => import("@/pages/me/MyPayslips"));
const MyProfile = lazy(() => import("@/pages/me/MyProfilePage"));
const MyAccount = lazy(() => import("@/pages/me/MyAccount"));
const MyNotifications = lazy(() => import("@/pages/me/MyNotifications"));
const MyLeave = lazy(() => import("@/pages/me/MyLeave"));
const Timesheets = lazy(() => import("@/pages/timesheets/MyTimesheets"));
const MyAttendance = lazy(() => import("@/pages/me/MyAttendance"));
const MyLoans = lazy(() => import("@/pages/me/MyLoans"));
const MyOnboarding = lazy(() => import("@/pages/me/MyOnboarding"));
const MyShifts = lazy(() => import("@/pages/me/MyShifts"));
const MyDocuments = lazy(() => import("@/pages/me/MyDocuments"));
const MyTaxCertificates = lazy(() => import("@/pages/me/MyTaxCertificates"));
const MyExitClearance = lazy(() => import("@/pages/me/MyExitClearance"));
const MySettings = lazy(() => import("@/pages/me/MySettings"));
const MyTalent = lazy(() => import("@/pages/me/MyTalent"));
const MyGoals = lazy(() => import("@/pages/me/MyGoals"));
const MyGoalDetail = lazy(() => import("@/pages/me/MyGoalDetail"));
const MyReviews = lazy(() => import("@/pages/me/MyReviews"));
const MyReviewDetail = lazy(() => import("@/pages/me/MyReviewDetail"));
const MyCompetencies = lazy(() => import("@/pages/me/MyCompetencies"));
const MyDevelopmentPlan = lazy(() => import("@/pages/me/MyDevelopmentPlan"));
const MyTeamPage = lazy(() => import("@/pages/me/MyTeamPage"));
const MyLearning = lazy(() => import("@/pages/me/MyLearningPage"));
const MyLearningCatalog = lazy(() => import("@/pages/me/MyLearningCatalog"));
const MyTeamLearning = lazy(() => import("@/pages/me/MyTeamLearningPage"));
const MyFeedback = lazy(() => import("@/pages/me/MyFeedback"));
const MyOneOnOnes = lazy(() => import("@/pages/me/MyOneOnOnes"));
const MyOneOnOneDetail = lazy(() => import("@/pages/me/MyOneOnOneDetail"));
const MyTeamTalent = lazy(() => import("@/pages/me/MyTeamTalent"));
const MyLearningPathsPage = lazy(() => import("@/pages/me/MyLearningPathsPage"));
const MyQuizPlayerPage = lazy(() => import("@/pages/me/MyQuizPlayerPage"));
const MyLeaveNew = lazy(() => import("@/pages/me/MyLeaveNew"));
const MyOneOnOneNew = lazy(() => import("@/pages/me/MyOneOnOneNew"));

const Lazy = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>{children}</Suspense>
);

export default function MeApp() {
  return (
    <SelfServiceProvider>
      <MePortalLayout>

      <Routes>
        {/* Default landing — friendly dashboard with quick actions */}
        <Route
          index
          element={
            <Lazy module="My Workspace">
              <MeHome />
            </Lazy>
          }
        />

        {/* My Profile — redirect to the linked HR employee profile if any,
            otherwise show the friendly fallback message. */}
        <Route
          path="profile"
          element={
            <Lazy module="My Profile">
              <MyProfile />
            </Lazy>
          }
        />

        {/* My Time Off — own leave requests + balances (portal-shaped) */}
        <Route
          path="leave"
          element={
            <Lazy module="My Leave">
              <MyLeave />
            </Lazy>
          }
        />
        <Route
          path="leave/new"
          element={
            <Lazy module="Request leave">
              <MyLeaveNew />
            </Lazy>
          }
        />



        {/* My Timesheets — own time entries */}
        <Route
          path="timesheets"
          element={
            <Lazy module="My Timesheets">
              <Timesheets />
            </Lazy>
          }
        />

        {/* My Attendance — own clock-in/out history */}
        <Route
          path="attendance"
          element={
            <Lazy module="My Attendance">
              <MyAttendance />
            </Lazy>
          }
        />

        {/* My Shifts — Turn E roster self-service */}
        <Route
          path="shifts"
          element={
            <Lazy module="My Shifts">
              <MyShifts />
            </Lazy>
          }
        />

        {/* My Payslips — purpose-built portal payslip surface */}
        <Route
          path="payslips"
          element={
            <Lazy module="My Payslips">
              <MyPayslips />
            </Lazy>
          }
        />


        {/* My Documents — purpose-built portal page with acknowledgement */}
        <Route
          path="documents"
          element={
            <Lazy module="My Documents">
              <MyDocuments />
            </Lazy>
          }
        />

        {/* My Tax Certificates — country-agnostic self-service for year-end
            statutory certificates (P9 / IRP5 / Lohnsteuerbescheinigung / …) */}
        <Route
          path="tax-certificates"
          element={
            <AppInstalledGate appId="payroll">
              <Lazy module="My Tax Certificates">
                <MyTaxCertificates />
              </Lazy>
            </AppInstalledGate>
          }
        />


        {/* My Loans & Advances — self-service request + tracking.
            Gated on the Payroll app because loans are a payroll surface. */}
        <Route
          path="loans"
          element={
            <AppInstalledGate appId="payroll">
              <Lazy module="My Loans">
                <MyLoans />
              </Lazy>
            </AppInstalledGate>
          }
        />

        {/* My Onboarding — auto-instantiated checklist for new hires */}
        <Route
          path="onboarding"
          element={
            <Lazy module="My Onboarding">
              <MyOnboarding />
            </Lazy>
          }
        />

        {/* My Exit Clearance — read-only progress for offboarding employees */}
        <Route
          path="exit"
          element={
            <Lazy module="My Exit Clearance">
              <MyExitClearance />
            </Lazy>
          }
        />

        {/* My Account — identity, password, preferences (User Account owner). */}
        <Route
          path="account"
          element={<Lazy module="My Account"><MyAccount /></Lazy>}
        />
        {/* Legacy /me/settings alias — thin index page linking to profile + account. */}
        <Route
          path="settings"
          element={<Lazy module="My Settings"><MySettings /></Lazy>}
        />
        {/* Notifications inside the portal shell (no more exits to /notifications). */}
        <Route
          path="notifications"
          element={<Lazy module="Notifications"><MyNotifications /></Lazy>}
        />

        {/* My Talent — goals, reviews, competencies, development plans (employee view) */}
        <Route
          path="talent"
          element={
            <Lazy module="My Talent">
              <MyTalent />
            </Lazy>
          }
        />
        <Route
          path="talent/goals"
          element={
            <Lazy module="My Goals">
              <MyGoals />
            </Lazy>
          }
        />
        <Route
          path="talent/goals/:goalId"
          element={
            <Lazy module="My Goal">
              <MyGoalDetail />
            </Lazy>
          }
        />
        <Route
          path="talent/reviews"
          element={
            <Lazy module="My Reviews">
              <MyReviews />
            </Lazy>
          }
        />
        <Route
          path="talent/reviews/:reviewId"
          element={
            <Lazy module="My Review">
              <MyReviewDetail />
            </Lazy>
          }
        />
        <Route
          path="talent/competencies"
          element={
            <Lazy module="My Competencies">
              <MyCompetencies />
            </Lazy>
          }
        />
        <Route
          path="talent/development"
          element={
            <Lazy module="My Development Plan">
              <MyDevelopmentPlan />
            </Lazy>
          }
        />
        <Route
          path="talent/feedback"
          element={
            <Lazy module="Feedback">
              <MyFeedback />
            </Lazy>
          }
        />
        <Route
          path="one-on-ones"
          element={
            <Lazy module="1:1 Meetings">
              <MyOneOnOnes />
            </Lazy>
          }
        />
        <Route
          path="one-on-ones/new"
          element={
            <Lazy module="Schedule 1:1">
              <MyOneOnOneNew />
            </Lazy>
          }
        />
        <Route
          path="one-on-ones/:id"
          element={
            <Lazy module="1:1">
              <MyOneOnOneDetail />
            </Lazy>
          }
        />

        <Route
          path="team"
          element={
            <Lazy module="My Team">
              <MyTeamPage />
            </Lazy>
          }
        />
        <Route
          path="learning"
          element={
            <Lazy module="My Learning">
              <MyLearning />
            </Lazy>
          }
        />
        <Route
          path="learning/catalog"
          element={
            <Lazy module="Course Catalog">
              <MyLearningCatalog />
            </Lazy>
          }
        />
        <Route
          path="learning/paths"
          element={
            <Lazy module="My Learning Paths">
              <MyLearningPathsPage />
            </Lazy>
          }
        />
        <Route
          path="learning/quiz/:quizId"
          element={
            <Lazy module="Quiz">
              <MyQuizPlayerPage />
            </Lazy>
          }
        />
        <Route
          path="team/learning"
          element={
            <Lazy module="Team Learning">
              <MyTeamLearning />
            </Lazy>
          }
        />
        <Route
          path="team/talent"
          element={
            <Lazy module="Team Talent">
              <MyTeamTalent />
            </Lazy>
          }
        />


        {/* Catch-all: send back to the workspace landing */}
        <Route path="*" element={<Navigate to="/me" replace />} />
      </Routes>
    </MePortalLayout>
    </SelfServiceProvider>


  );
}
