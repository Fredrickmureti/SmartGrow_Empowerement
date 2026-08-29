/**
 * Contacts App Routes
 * 
 * Defines all routes for the Contacts app including:
 * - All Contacts (unified view)
 * - Customers (filtered)
 * - Suppliers (filtered)
 * - Companies (filtered)
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { InstitutionRoute } from "@/components/auth/InstitutionRoute";
import { ContactsLayout } from "./ContactsLayout";
import Contacts from "@/pages/Contacts";

const ContactProfile = lazy(() => import("@/pages/contacts/ContactProfile"));
const ContactCreatePage = lazy(
  () => import("@/features/contacts/ContactCreatePage"),
);
const ContactEditPage = lazy(
  () => import("@/features/contacts/ContactEditPage"),
);

/**
 * Contacts App Component
 */
export function ContactsApp() {
  return (
    <ContactsLayout>
      <Routes>
        {/* Default - All Contacts */}
        <Route
          index
          element={
            <InstitutionRoute allowReadOnly>
              <Contacts />
            </InstitutionRoute>
          }
        />
        
        {/* Customers (filtered to type=customer or both) */}
        <Route
          path="customers"
          element={
            <InstitutionRoute allowReadOnly>
              <Contacts defaultTypeFilter="customer" />
            </InstitutionRoute>
          }
        />
        
        {/* Retired: suppliers are a procurement role, owned by Purchases.
            This route existed as a second supplier surface that wrote
            contacts.supplier_rank directly and never created the supplier
            role record. It now redirects to the canonical master. */}
        <Route
          path="vendors"
          element={<Navigate to="/purchases/suppliers" replace />}
        />
        
        {/* Companies (filtered to contacts with company field) */}
        <Route
          path="companies"
          element={
            <InstitutionRoute allowReadOnly>
              <Contacts showCompaniesOnly />
            </InstitutionRoute>
          }
        />

        {/* Create — Phase 12 routed record form */}
        <Route
          path="new"
          element={
            <InstitutionRoute>
              <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>}>
                <ContactCreatePage />
              </Suspense>
            </InstitutionRoute>
          }
        />

        {/* Edit — Phase 12 routed record form */}
        <Route
          path=":id/edit"
          element={
            <InstitutionRoute>
              <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>}>
                <ContactEditPage />
              </Suspense>
            </InstitutionRoute>
          }
        />

        {/* Contact Profile - 360-degree view */}
        <Route
          path="profile"
          element={
            <InstitutionRoute allowReadOnly>
              <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>}>
                <ContactProfile />
              </Suspense>
            </InstitutionRoute>
          }
        />
        
        {/* Catch all */}
        <Route path="*" element={<Navigate to="" replace />} />
      </Routes>
    </ContactsLayout>
  );
}

export default ContactsApp;
