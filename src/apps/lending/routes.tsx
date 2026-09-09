/**
 * Lending App Routes — C1 scaffold.
 *
 * The route surface is fixed now so later milestones only swap placeholder
 * elements for real pages, without touching the shell, nav or App.tsx.
 */

import { Routes, Route, Navigate } from "react-router-dom";
import { InstitutionRoute } from "@/components/auth/InstitutionRoute";
import { PermissionProtectedRoute } from "@/components/auth/PermissionProtectedRoute";
import { LendingLayout } from "./LendingLayout";
import { PlaceholderSurface } from "./PlaceholderSurface";
import { AccountingMappingsPage } from "./settings/AccountingMappingsPage";
import { ClientsPage } from "./clients/ClientsPage";
import { GroupsPage } from "./groups/GroupsPage";
import { ProductsPage } from "./products/ProductsPage";
import { ApplicationsPage } from "./applications/ApplicationsPage";
import { LoansPage } from "./loans/LoansPage";
import { RepaymentsPage } from "./repayments/RepaymentsPage";
import { MeetingsPage } from "./meetings/MeetingsPage";
import { CollectionsPage } from "./collections/CollectionsPage";
import { PortfolioReport } from "./reports/PortfolioReport";
import { ArrearsReport } from "./reports/ArrearsReport";
import { CollectionsReport } from "./reports/CollectionsReport";
import { DisbursementsReport } from "./reports/DisbursementsReport";
import { ClientStatementReport } from "./reports/ClientStatementReport";
import { OfficerCollectionsReport } from "./reports/OfficerCollectionsReport";
import { ProductPerformanceReport } from "./reports/ProductPerformanceReport";
import { ClientExposureReport } from "./reports/ClientExposureReport";
import { ParAgingReport } from "./reports/ParAgingReport";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

const SURFACES: Array<{
  path: string;
  index?: boolean;
  title: string;
  description: string;
  milestone: string;
}> = [];

export function LendingApp() {
  return (
    <LendingLayout>
      <Routes>
        <Route
          index
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewClients">
              <ClientsPage />
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="groups"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewClients">
              <GroupsPage />
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="applications"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewApplications">
              <ApplicationsPage />
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="loans"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLoans">
              <LoansPage />
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="meetings"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewClients">
              <MeetingsPage />
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="repayments"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="recordRepayments">
              <RepaymentsPage />
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="collections"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewCollections">
              <CollectionsPage />
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="products"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLoanProducts">
              <ProductsPage />
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />

        <Route
          path="reports/portfolio"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLendingReports">
              <ReportFilterProvider><PortfolioReport /></ReportFilterProvider>
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="reports/arrears"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLendingReports">
              <ReportFilterProvider><ArrearsReport /></ReportFilterProvider>
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="reports/collections"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLendingReports">
              <ReportFilterProvider><CollectionsReport /></ReportFilterProvider>
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="reports/client-statement"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLendingReports">
              <ReportFilterProvider><ClientStatementReport /></ReportFilterProvider>
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="reports/officer-collections"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLendingReports">
              <ReportFilterProvider><OfficerCollectionsReport /></ReportFilterProvider>
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="reports/product-performance"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLendingReports">
              <ReportFilterProvider><ProductPerformanceReport /></ReportFilterProvider>
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="reports/client-exposure"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLendingReports">
              <ReportFilterProvider><ClientExposureReport /></ReportFilterProvider>
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="reports/par-aging"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLendingReports">
              <ReportFilterProvider><ParAgingReport /></ReportFilterProvider>
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />
        <Route
          path="reports/disbursements"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="viewLendingReports">
              <ReportFilterProvider><DisbursementsReport /></ReportFilterProvider>
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />

        {SURFACES.map(({ path, index, title, description, milestone }) => {
          const element = (
            <InstitutionRoute allowReadOnly>
              <PlaceholderSurface
                title={title}
                description={description}
                milestone={milestone}
              />
            </InstitutionRoute>
          );

          return index ? (
            <Route key="index" index element={element} />
          ) : (
            <Route key={path} path={path} element={element} />
          );
        })}

        <Route
          path="configuration/accounting"
          element={
            <InstitutionRoute allowReadOnly>
              <PermissionProtectedRoute permission="manageLendingConfig">
              <AccountingMappingsPage />
            </PermissionProtectedRoute>
            </InstitutionRoute>
          }
        />

        <Route path="*" element={<Navigate to="" replace />} />
      </Routes>
    </LendingLayout>
  );
}

export default LendingApp;
