/**
 * Sales App Routes
 * 
 * Odoo-style: If the "sales" app is enabled for the plan, ALL Sales pages are accessible.
 * No per-page feature gating — app-level access is the primary commercial unit.
 * Premium cross-cutting features (multi_currency, ai_assistant, etc.) may gate
 * specific UI elements within pages, but not entire pages.
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SubscriptionProtectedRoute } from "@/components/subscription/SubscriptionProtectedRoute";
import { SalesLayout } from "./SalesLayout";

// Eager imports for commonly accessed pages
import Invoices from "@/pages/Invoices";
const InvoiceRecordPage = lazy(() => import("@/features/sales/invoices/InvoiceRecordPage"));
const InvoiceCreatePage = lazy(() => import("@/features/sales/invoices/InvoiceCreatePage"));
const InvoiceEditPage = lazy(() => import("@/features/sales/invoices/InvoiceEditPage"));
const SalesDashboard = lazy(() => import("@/pages/sales/SalesDashboard"));
import CustomerPayments from "@/pages/CustomerPayments";
import Contacts from "@/pages/Contacts";

// Lazy imports
const RecurringInvoices = lazy(() => import("@/pages/RecurringInvoices"));
const RecurringInvoiceRecordPage = lazy(() => import("@/features/sales/recurring/RecurringInvoiceRecordPage"));
const CustomerPaymentRecordPage = lazy(() => import("@/features/sales/payments/CustomerPaymentRecordPage"));
const CustomerRecordPage = lazy(() => import("@/features/sales/customers/CustomerRecordPage"));
const Estimates = lazy(() => import("@/pages/Estimates"));
const EstimateRecordPage = lazy(() => import("@/features/sales/estimates/EstimateRecordPage"));
const EstimateCreatePage = lazy(() => import("@/features/sales/estimates/EstimateCreatePage"));
const EstimateEditPage = lazy(() => import("@/features/sales/estimates/EstimateEditPage"));
const ProformaInvoices = lazy(() => import("@/pages/ProformaInvoices"));
const ProformaRecordPage = lazy(() => import("@/features/sales/proforma/ProformaRecordPage"));
const ProformaCreatePage = lazy(() => import("@/features/sales/proforma/ProformaCreatePage"));
const SalesOrders = lazy(() => import("@/pages/SalesOrders"));
const SalesOrderRecordPage = lazy(() => import("@/features/sales/orders/SalesOrderRecordPage"));
const SalesOrderCreatePage = lazy(() => import("@/features/sales/orders/SalesOrderCreatePage"));
const SalesOrderEditPage = lazy(() => import("@/features/sales/orders/SalesOrderEditPage"));
const DeliveryNotes = lazy(() => import("@/pages/DeliveryNotes"));
const DeliveryNoteRecordPage = lazy(() => import("@/features/sales/delivery-notes/DeliveryNoteRecordPage"));
const DeliveryNoteCreatePage = lazy(() => import("@/features/sales/delivery-notes/DeliveryNoteCreatePage"));
const CreditNotes = lazy(() => import("@/pages/CreditNotes"));
const CreditNoteRecordPage = lazy(() => import("@/features/sales/credit-notes/CreditNoteRecordPage"));
const CreditNoteCreatePage = lazy(() => import("@/features/sales/credit-notes/CreditNoteCreatePage"));
const CreditNoteEditPage = lazy(() => import("@/features/sales/credit-notes/CreditNoteEditPage"));
const SalesReturns = lazy(() => import("@/pages/SalesReturns"));
const SalesReturnRecordPage = lazy(() => import("@/features/sales/returns/SalesReturnRecordPage"));
const SalesReturnCreatePage = lazy(() => import("@/features/sales/returns/SalesReturnCreatePage"));
const CustomerStatements = lazy(() => import("@/pages/CustomerStatements"));
const SalespersonPerformance = lazy(() => import("@/pages/sales/SalespersonPerformance"));
const CustomerLedger = lazy(() => import("@/pages/sales/CustomerLedger"));
const CustomerLedgerIndex = lazy(() => import("@/pages/sales/CustomerLedgerIndex"));
const Collections = lazy(() => import("@/pages/sales/Collections"));

// Wrapper for lazy routes
const LazyRoute = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>
    {children}
  </Suspense>
);

/**
 * Sales App Component
 */
export function SalesApp() {
  return (
    <SalesLayout>
      <Routes>
        {/* Default redirect to dashboard */}
        <Route index element={<Navigate to="dashboard" replace />} />
        
        {/* Sales Dashboard */}
        <Route
          path="dashboard"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Sales Dashboard">
                <SalesDashboard />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Invoices */}
        <Route
          path="invoices"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <Invoices />
            </SubscriptionProtectedRoute>
          }
        />

        {/* Invoice — create route (Phase 3 record-form migration) */}
        <Route
          path="invoices/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Invoice">
                <InvoiceCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Invoice — edit route (Phase 3 record-form migration) */}
        <Route
          path="invoices/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Invoice">
                <InvoiceEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Invoice — object page (Phase 1 record migration) */}
        <Route
          path="invoices/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Invoice">
                <InvoiceRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />



        
        {/* Recurring Invoices */}
        <Route
          path="recurring"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Recurring Invoices">
                <RecurringInvoices />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Recurring Invoice — object page */}
        <Route
          path="recurring/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Recurring Invoice">
                <RecurringInvoiceRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Estimates */}
        <Route
          path="estimates"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Estimates">
                <Estimates />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Estimate — create route (Phase 3 record-form migration) */}
        <Route
          path="estimates/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Estimate">
                <EstimateCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Estimate — edit route (Phase 3 record-form migration) */}
        <Route
          path="estimates/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Estimate">
                <EstimateEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Estimate — object page (Phase 1 record migration) */}
        <Route
          path="estimates/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Estimate">
                <EstimateRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        

        
        {/* Proforma Invoices */}
        <Route
          path="proforma"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Proforma Invoices">
                <ProformaInvoices />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Proforma — create route (Phase 3 record-form migration) */}
        <Route
          path="proforma/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Proforma Invoice">
                <ProformaCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Proforma — object page */}
        <Route
          path="proforma/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Proforma Invoice">
                <ProformaRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Sales Orders */}
        <Route
          path="orders"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Sales Orders">
                <SalesOrders />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Sales Order — create route (Phase 3 record-form migration) */}
        <Route
          path="orders/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Sales Order">
                <SalesOrderCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Sales Order — edit route (Phase 3 record-form migration) */}
        <Route
          path="orders/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Sales Order">
                <SalesOrderEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Sales Order — object page (Phase 1 record migration) */}
        <Route
          path="orders/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Sales Order">
                <SalesOrderRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />



        
        {/* Delivery Notes */}
        <Route
          path="delivery-notes"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Delivery Notes">
                <DeliveryNotes />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Delivery Note — create route (Phase 3 record-form migration) */}
        <Route
          path="delivery-notes/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Delivery Note">
                <DeliveryNoteCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Delivery Note — object page */}
        <Route
          path="delivery-notes/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Delivery Note">
                <DeliveryNoteRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Customer Payments */}
        <Route
          path="payments"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <CustomerPayments />
            </SubscriptionProtectedRoute>
          }
        />

        {/* Customer Payment — object page */}
        <Route
          path="payments/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Customer Payment">
                <CustomerPaymentRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Customer Statements */}
        <Route
          path="statements"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Customer Statements">
                <CustomerStatements />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Sales Returns */}
        <Route
          path="returns"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Sales Returns">
                <SalesReturns />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Sales Return — create route (Phase 3 record-form migration) */}
        <Route
          path="returns/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Sales Return">
                <SalesReturnCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Sales Return — object page */}
        <Route
          path="returns/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Sales Return">
                <SalesReturnRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Credit Notes */}
        <Route
          path="credit-notes"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Credit Notes">
                <CreditNotes />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Credit Note — create route (Phase 3 record-form migration) */}
        <Route
          path="credit-notes/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Credit Note">
                <CreditNoteCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Credit Note — edit route (Phase 3 record-form migration) */}
        <Route
          path="credit-notes/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Credit Note">
                <CreditNoteEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Credit Note — object page */}
        <Route
          path="credit-notes/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Credit Note">
                <CreditNoteRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Salesperson Performance */}
        <Route
          path="salesperson"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Salesperson Performance">
                <SalespersonPerformance />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Customers (filtered contacts) */}
        <Route
          path="customers"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <Contacts defaultTypeFilter="customer" />
            </SubscriptionProtectedRoute>
          }
        />

        {/* Customer — object page (must come BEFORE any dynamic child route so
            :id resolves consistently, but AFTER the static list route above) */}
        <Route
          path="customers/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Customer">
                <CustomerRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />


        {/* Customer Ledger (ADR 0027) — chronological AR view */}
        <Route
          path="customers/:id/ledger"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Customer Ledger">
                <CustomerLedger />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Collections workspace — actionable AR aging */}
        <Route
          path="collections"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Collections">
                <Collections />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Catch all */}
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </SalesLayout>
  );
}

export default SalesApp;
