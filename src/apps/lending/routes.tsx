/**
 * Lending App Routes — C1 scaffold.
 *
 * The route surface is fixed now so later milestones only swap placeholder
 * elements for real pages, without touching the shell, nav or App.tsx.
 */

import { Routes, Route, Navigate } from "react-router-dom";
import { InstitutionRoute } from "@/components/auth/InstitutionRoute";
import { LendingLayout } from "./LendingLayout";
import { PlaceholderSurface } from "./PlaceholderSurface";
import { AccountingMappingsPage } from "./settings/AccountingMappingsPage";
import { ClientsPage } from "./clients/ClientsPage";
import { GroupsPage } from "./groups/GroupsPage";
import { ProductsPage } from "./products/ProductsPage";
import { ApplicationsPage } from "./applications/ApplicationsPage";
import { LoansPage } from "./loans/LoansPage";
import { RepaymentsPage } from "./repayments/RepaymentsPage";
import { CollectionsPage } from "./collections/CollectionsPage";

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
              <ClientsPage />
            </InstitutionRoute>
          }
        />
        <Route
          path="groups"
          element={
            <InstitutionRoute allowReadOnly>
              <GroupsPage />
            </InstitutionRoute>
          }
        />
        <Route
          path="applications"
          element={
            <InstitutionRoute allowReadOnly>
              <ApplicationsPage />
            </InstitutionRoute>
          }
        />
        <Route
          path="loans"
          element={
            <InstitutionRoute allowReadOnly>
              <LoansPage />
            </InstitutionRoute>
          }
        />
        <Route
          path="repayments"
          element={
            <InstitutionRoute allowReadOnly>
              <RepaymentsPage />
            </InstitutionRoute>
          }
        />
        <Route
          path="collections"
          element={
            <InstitutionRoute allowReadOnly>
              <CollectionsPage />
            </InstitutionRoute>
          }
        />
        <Route
          path="products"
          element={
            <InstitutionRoute allowReadOnly>
              <ProductsPage />
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
              <AccountingMappingsPage />
            </InstitutionRoute>
          }
        />

        <Route path="*" element={<Navigate to="" replace />} />
      </Routes>
    </LendingLayout>
  );
}

export default LendingApp;
