/**
 * Purchases App Routes
 * 
 * Odoo-style: If the "purchases" app is enabled, ALL pages are accessible.
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SubscriptionProtectedRoute } from "@/components/subscription/SubscriptionProtectedRoute";
import { PurchasesLayout } from "./PurchasesLayout";

// Eager imports
import Expenses from "@/pages/Expenses";
import Contacts from "@/pages/Contacts";

// Lazy imports
const PurchasesDashboard = lazy(() => import("@/pages/purchases/PurchasesDashboard"));
const Bills = lazy(() => import("@/pages/Bills"));
const PurchaseOrders = lazy(() => import("@/pages/PurchaseOrders"));
const PurchaseOrderRecordPage = lazy(
  () => import("@/features/purchases/orders/PurchaseOrderRecordPage"),
);
const PurchaseOrderCreatePage = lazy(
  () => import("@/features/purchases/orders/PurchaseOrderCreatePage"),
);
const BillRecordPage = lazy(
  () => import("@/features/purchases/bills/BillRecordPage"),
);
const BillEditPage = lazy(
  () => import("@/features/purchases/bills/BillEditPage"),
);
const PurchaseOrderEditPage = lazy(
  () => import("@/features/purchases/orders/PurchaseOrderEditPage"),
);
const GoodsReceiptWizardPage = lazy(
  () => import("@/features/purchases/goods-receipt/GoodsReceiptWizardPage"),
);
const PurchaseReturns = lazy(() => import("@/pages/PurchaseReturns"));
const PurchaseReturnCreatePage = lazy(
  () => import("@/features/purchases/returns/PurchaseReturnCreatePage"),
);
const PurchaseReturnEditPage = lazy(
  () => import("@/features/purchases/returns/PurchaseReturnEditPage"),
);
const PurchaseReturnRecordPage = lazy(
  () => import("@/features/purchases/returns/PurchaseReturnRecordPage"),
);
const VendorPriceLists = lazy(() => import("@/pages/VendorPriceLists"));
const RFQs = lazy(() => import("@/pages/RFQs"));
const VendorCreditNotes = lazy(() => import("@/pages/VendorCreditNotes"));
const VendorCreditNoteCreatePage = lazy(
  () => import("@/features/purchases/credit-notes/VendorCreditNoteCreatePage"),
);
const VendorCreditNoteEditPage = lazy(
  () => import("@/features/purchases/credit-notes/VendorCreditNoteEditPage"),
);
const VendorCreditNoteRecordPage = lazy(
  () => import("@/features/purchases/credit-notes/VendorCreditNoteRecordPage"),
);

const VendorStatements = lazy(() => import("@/pages/VendorStatements"));
const AgedPayables = lazy(() => import("@/pages/purchases/AgedPayables"));

// Wrapper for lazy routes
const LazyRoute = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>
    {children}
  </Suspense>
);

/**
 * Purchases App Component
 */
export function PurchasesApp() {
  return (
    <PurchasesLayout>
      <Routes>
        {/* Default redirect to bills */}
        <Route index element={<LazyRoute module="Purchases"><PurchasesDashboard /></LazyRoute>} />
        
        {/* Bills */}
        <Route
          path="bills"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Bills">
                <Bills />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Bill — object page (record shell) */}
        <Route
          path="bills/new"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Bill">
                <BillRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="bills/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Bill">
                <BillRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="bills/:id/edit"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Bill">
                <BillEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* RFQs */}
        <Route
          path="rfqs"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="RFQs">
                <RFQs />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Purchase Orders */}
        <Route
          path="orders"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Purchase Orders">
                <PurchaseOrders />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Purchase Order — object page (record shell) */}
        <Route
          path="orders/new"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Purchase Order">
                <PurchaseOrderCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="orders/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Purchase Order">
                <PurchaseOrderRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="orders/:id/edit"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Purchase Order">
                <PurchaseOrderEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Goods Receipt — wizard route */}
        <Route
          path="goods-receipt/new"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Goods Receipt">
                <GoodsReceiptWizardPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Expenses */}
        <Route
          path="expenses"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <Expenses />
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Purchase Returns */}
        <Route
          path="returns"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Purchase Returns">
                <PurchaseReturns />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="returns/new"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Purchase Return">
                <PurchaseReturnCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="returns/:id/edit"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Purchase Return">
                <PurchaseReturnEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="returns/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Purchase Return">
                <PurchaseReturnRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        
        {/* Vendor Price Lists */}
        <Route
          path="price-lists"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Price Lists">
                <VendorPriceLists />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Vendor Credit Notes */}
        <Route
          path="credit-notes"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Vendor Credit Notes">
                <VendorCreditNotes />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="credit-notes/new"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Vendor Credit Note">
                <VendorCreditNoteCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="credit-notes/:id/edit"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Vendor Credit Note">
                <VendorCreditNoteEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="credit-notes/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Vendor Credit Note">
                <VendorCreditNoteRecordPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        
        {/* Vendors (filtered contacts) */}
        <Route
          path="vendors"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <Contacts defaultTypeFilter="supplier" />
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Vendor Statements */}
        <Route
          path="statements"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Vendor Statements">
                <VendorStatements />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Aged Payables Report */}
        <Route
          path="aged-payables"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Aged Payables">
                <AgedPayables />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Catch all */}
        <Route path="*" element={<Navigate to="bills" replace />} />
      </Routes>
    </PurchasesLayout>
  );
}

export default PurchasesApp;
