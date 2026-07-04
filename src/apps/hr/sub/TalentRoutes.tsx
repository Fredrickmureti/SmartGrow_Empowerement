/**
 * Talent Sub-App Routes — mounts at /hr/talent/*.
 *
 * Houses HR & Manager surfaces for performance cycles, goals, reviews,
 * competencies, development plans, and learning. Employee-facing equivalents
 * live under /me/talent/* in MeApp.
 */
import { lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { PermissionProtectedRoute } from "@/components/auth/PermissionProtectedRoute";
import { TALENT_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { TALENT_NAV } from "../shared/navs";
import { LazyRoute } from "../shared/guards";

const TalentDashboard = lazy(() => import("@/pages/hr/talent/TalentDashboard"));
const CyclesPage = lazy(() => import("@/pages/hr/talent/CyclesPage"));
const CycleParticipationPage = lazy(() => import("@/pages/hr/talent/CycleParticipationPage"));
const CalibrationPage = lazy(() => import("@/pages/hr/talent/CalibrationPage"));
const GoalsPage = lazy(() => import("@/pages/hr/talent/GoalsPage"));
const GoalsCascadePage = lazy(() => import("@/pages/hr/talent/GoalsCascadePage"));
const GoalDetailPage = lazy(() => import("@/pages/hr/talent/GoalDetailPage"));
const ReviewsPage = lazy(() => import("@/pages/hr/talent/ReviewsPage"));
const ReviewDetailPage = lazy(() => import("@/pages/hr/talent/ReviewDetailPage"));
const ReviewTemplatesPage = lazy(() => import("@/pages/hr/talent/ReviewTemplatesPage"));
const CompetenciesPage = lazy(() => import("@/pages/hr/talent/CompetenciesPage"));
const DevelopmentPlansPage = lazy(() => import("@/pages/hr/talent/DevelopmentPlansPage"));
const LearningPage = lazy(() => import("@/pages/hr/talent/LearningPage"));
const LearningReportsPage = lazy(() => import("@/pages/hr/talent/LearningReportsPage"));
const NineBoxPage = lazy(() => import("@/pages/hr/talent/NineBoxPage"));
const SuccessionPage = lazy(() => import("@/pages/hr/talent/SuccessionPage"));
const TalentAnalyticsPage = lazy(() => import("@/pages/hr/talent/TalentAnalyticsPage"));
const MeritPage = lazy(() => import("@/pages/hr/talent/MeritPage"));
const LearningPathsPage = lazy(() => import("@/pages/hr/talent/LearningPathsPage"));
const QuizAuthorPage = lazy(() => import("@/pages/hr/talent/QuizAuthorPage"));
const TalentSettingsPage = lazy(() => import("@/pages/hr/talent/TalentSettingsPage"));

const guarded = (mod: string, el: React.ReactNode) => (
  <PermissionProtectedRoute permission="manageEmployees" fallbackPath="/hr/dashboard">
    <LazyRoute module={mod}>{el}</LazyRoute>
  </PermissionProtectedRoute>
);

export default function TalentApp() {
  return (
    <PlatformShell app={TALENT_APP} nav={TALENT_NAV}>
      <Routes>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard"          element={guarded("Talent Dashboard", <TalentDashboard />)} />
        <Route path="cycles"             element={guarded("Performance Cycles", <CyclesPage />)} />
        <Route path="cycles/:cycleId/participation" element={guarded("Cycle Participation", <CycleParticipationPage />)} />
        <Route path="cycles/:cycleId/calibration"   element={guarded("Calibration", <CalibrationPage />)} />
        <Route path="goals"              element={guarded("Goals", <GoalsPage />)} />
        <Route path="goals/cascade"      element={guarded("Goal Cascade", <GoalsCascadePage />)} />
        <Route path="goals/:goalId"      element={guarded("Goal", <GoalDetailPage />)} />
        <Route path="reviews"            element={guarded("Reviews", <ReviewsPage />)} />
        <Route path="reviews/:reviewId"  element={guarded("Review", <ReviewDetailPage />)} />
        <Route path="review-templates"            element={guarded("Review Templates", <ReviewTemplatesPage />)} />
        <Route path="review-templates/:templateId" element={guarded("Review Template", <ReviewTemplatesPage />)} />
        <Route path="competencies"       element={guarded("Competencies", <CompetenciesPage />)} />
        <Route path="development"        element={guarded("Development Plans", <DevelopmentPlansPage />)} />
        <Route path="learning"           element={guarded("Learning", <LearningPage />)} />
        <Route path="learning/reports"   element={guarded("Learning Reports", <LearningReportsPage />)} />
        <Route path="nine-box"           element={guarded("9-Box Talent Grid", <NineBoxPage />)} />
        <Route path="succession"         element={guarded("Succession Planning", <SuccessionPage />)} />
        <Route path="analytics"          element={guarded("Talent Analytics", <TalentAnalyticsPage />)} />
        <Route path="merit"              element={guarded("Merit & Compensation", <MeritPage />)} />
        <Route path="learning/paths"     element={guarded("Learning Paths", <LearningPathsPage />)} />
        <Route path="quizzes"            element={guarded("Quiz Authoring", <QuizAuthorPage />)} />
        <Route path="*"                  element={<Navigate to="dashboard" replace />} />
      </Routes>
    </PlatformShell>
  );
}
