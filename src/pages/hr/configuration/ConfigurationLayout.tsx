/**
 * HR Configuration — administration workspace shell.
 *
 * Wave J: stripped the sticky 260px sidebar that duplicated the Overview
 * landing page. Configuration is now a flat content column — Overview is
 * the single nav surface; sub-pages render with their own
 * `ConfigPageHeader` (back link + page-title).
 */
import { Routes, Route, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";

const Overview = lazy(() => import("./OverviewPage"));
const OnboardingTemplates = lazy(() => import("./OnboardingTemplatesPage"));
const OnboardingEditor = lazy(() => import("./OnboardingTemplateEditor"));
const StatutoryFields = lazy(() => import("./StatutoryFieldsPage"));
const Policies = lazy(() => import("./HRPoliciesPage"));
const DocumentCategories = lazy(() => import("./DocumentCategoriesPage"));
const PublicHolidays = lazy(() => import("./PublicHolidaysPage"));
const Competencies = lazy(() => import("./CompetenciesPage"));
const Maintenance = lazy(() => import("./MaintenancePage"));

export default function ConfigurationLayout() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="onboarding-templates" element={<OnboardingTemplates />} />
        <Route path="onboarding-templates/:id" element={<OnboardingEditor />} />
        <Route path="statutory-fields" element={<StatutoryFields />} />
        <Route path="document-categories" element={<DocumentCategories />} />
        <Route path="competencies" element={<Competencies />} />
        <Route path="public-holidays" element={<PublicHolidays />} />
        <Route path="policies" element={<Policies />} />
        <Route path="maintenance" element={<Maintenance />} />
        {/* Sections that live on dedicated pages — redirect there */}
        <Route path="departments" element={<Navigate to="/hr/departments" replace />} />
        <Route path="job-positions" element={<Navigate to="/hr/job-positions" replace />} />
        <Route path="work-locations" element={<Navigate to="/hr/work-locations" replace />} />
        <Route path="benefit-windows" element={<Navigate to="/hr/benefit-windows" replace />} />
        <Route path="*" element={<Navigate to="." replace />} />
      </Routes>
    </Suspense>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
