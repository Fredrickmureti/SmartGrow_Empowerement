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

const SURFACES: Array<{
  path: string;
  index?: boolean;
  title: string;
  description: string;
  milestone: string;
}> = [
  {
    path: "products",
    title: "Loan products",
    description: "Amount bands, terms, frequencies, interest methods, fees and penalties — versioned.",
    milestone: "C4",
  },
  {
    path: "applications",
    title: "Applications",
    description: "Draft to approval pipeline with assessment and approval authority.",
    milestone: "C5",
  },
  {
    path: "loans",
    title: "Loans",
    description: "Contractual loans, repayment schedules and disbursement.",
    milestone: "C6",
  },
  {
    path: "repayments",
    title: "Repayments",
    description: "Payment capture, allocation, receipts and reversals.",
    milestone: "C7",
  },
  {
    path: "collections",
    title: "Collections",
    description: "Arrears, days past due, visits and promises to pay by officer portfolio.",
    milestone: "C7",
  },
];

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
