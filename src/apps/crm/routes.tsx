/**
 * CRM App Routes
 * 
 * Odoo-style: If the "crm" app is enabled, ALL pages are accessible.
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SubscriptionProtectedRoute } from "@/components/subscription/SubscriptionProtectedRoute";
import { OnlineOnlyRoute } from "@/components/electron/OnlineOnlyRoute";
import { CRMLayout } from "./CRMLayout";

// Eager imports
import Contacts from "@/pages/Contacts";

// Lazy imports
const CRMPipeline = lazy(() => import("@/pages/crm/CRMPipeline"));
const CRMLeads = lazy(() => import("@/pages/crm/CRMLeads"));
const CRMActivities = lazy(() => import("@/pages/crm/CRMActivities"));
const CRMDashboard = lazy(() => import("@/pages/crm/CRMDashboard"));
const ContactProfile = lazy(() => import("@/pages/contacts/ContactProfile"));

// Wrapper for lazy routes
const LazyRoute = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>
    {children}
  </Suspense>
);

/**
 * CRM App Component
 */
export function CRMApp() {
  return (
    <CRMLayout>
      <Routes>
        {/* Default redirect to dashboard */}
        <Route index element={<Navigate to="dashboard" replace />} />
        
        {/* CRM Dashboard */}
        <Route
          path="dashboard"
          element={
            <OnlineOnlyRoute moduleName="CRM Dashboard">
              <SubscriptionProtectedRoute allowReadOnly>
                <LazyRoute module="CRM Dashboard">
                  <CRMDashboard />
                </LazyRoute>
              </SubscriptionProtectedRoute>
            </OnlineOnlyRoute>
          }
        />
        
        {/* Leads — record management surface. The kanban board only renders
            opportunities that sit in a stage, so this list is the canonical
            place to find, search and inspect every lead. */}
        <Route
          path="leads"
          element={
            <OnlineOnlyRoute moduleName="CRM Leads">
              <SubscriptionProtectedRoute allowReadOnly>
                <LazyRoute module="CRM Leads">
                  <CRMLeads />
                </LazyRoute>
              </SubscriptionProtectedRoute>
            </OnlineOnlyRoute>
          }
        />
        
        {/* Pipeline */}
        <Route
          path="pipeline"
          element={
            <OnlineOnlyRoute moduleName="CRM Pipeline">
              <SubscriptionProtectedRoute allowReadOnly>
                <LazyRoute module="CRM Pipeline">
                  <CRMPipeline />
                </LazyRoute>
              </SubscriptionProtectedRoute>
            </OnlineOnlyRoute>
          }
        />
        
        {/* Activities */}
        <Route
          path="activities"
          element={
            <OnlineOnlyRoute moduleName="CRM Activities">
              <SubscriptionProtectedRoute allowReadOnly>
                <LazyRoute module="CRM Activities">
                  <CRMActivities />
                </LazyRoute>
              </SubscriptionProtectedRoute>
            </OnlineOnlyRoute>
          }
        />
        
        {/* Contact Profile within CRM context */}
        <Route
          path="contacts/profile"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Contact Profile">
                <ContactProfile />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* All Contacts */}
        <Route
          path="contacts"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <Contacts />
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Catch all */}
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </CRMLayout>
  );
}

export default CRMApp;
