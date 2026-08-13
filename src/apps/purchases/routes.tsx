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
const BillCreatePage = lazy(
  () => import("@/features/purchases/bills/BillCreatePage"),
);
const BillEditPage = lazy(
  () => import("@/features/purchases/bills/BillEditPage"),
);
const PurchaseOrderEditPage = lazy(
  () => import("@/features/purchases/orders/PurchaseOrderEditPage"),
);
const ExpenseCreatePage = lazy(
  () => import("@/features/purchases/expenses/ExpenseCreatePage"),
);
const ExpenseEditPage = lazy(
  () => import("@/features/purchases/expenses/ExpenseEditPage"),
);
// GRN convergence: goods receipts are captured in the WMS receiving session
// (`/warehouse-app/receiving`) and produced as a document by posting it. This
// legacy route only forwards historic deep links.
const GoodsReceiptRedirect = lazy(
  () => import("@/features/purchases/goods-receipt/GoodsReceiptRedirect"),
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
const RFQCreatePage = lazy(
  () => import("@/features/purchases/rfqs/RFQCreatePage"),
);
const RFQEditPage = lazy(
  () => import("@/features/purchases/rfqs/RFQEditPage"),
);
const RFQRecordPage = lazy(
  () => import("@/features/purchases/rfqs/RFQRecordPage"),
);
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
const VendorStatementRecordPage = lazy(
  () => import("@/features/purchases/statements/VendorStatementRecordPage"),
);
const AgedPayables = lazy(() => import("@/pages/purchases/AgedPayables"));
const ApReconciliation = lazy(() => import("@/pages/purchases/ApReconciliation"));
// Landed Cost (ADR 0077) — voucher domain: list → create → record.
const LandedCostListPage = lazy(
  () => import("@/features/purchases/landed-costs/LandedCostListPage"),
);
const LandedCostCreatePage = lazy(
  () => import("@/features/purchases/landed-costs/LandedCostCreatePage"),
);
const LandedCostRecordPage = lazy(
  () => import("@/features/purchases/landed-costs/LandedCostRecordPage"),
);

// P1 — Supplier 360 workbench (canonical supplier master).
const SupplierListPage = lazy(
  () => import("@/features/purchases/suppliers/SupplierListPage"),
);
const SupplierCreatePage = lazy(
  () => import("@/features/purchases/suppliers/SupplierCreatePage"),
);
const SupplierRecordPage = lazy(
  () => import("@/features/purchases/suppliers/SupplierRecordPage"),
);

// P2 — Contracts workbench.
const ContractListPage = lazy(
  () => import("@/features/purchases/contracts/ContractListPage"),
);
const ContractCreatePage = lazy(
  () => import("@/features/purchases/contracts/ContractCreatePage"),
);
const ContractRecordPage = lazy(
  () => import("@/features/purchases/contracts/ContractRecordPage"),
);

// P3 — Requisitions workbench.
const RequisitionListPage = lazy(
  () => import("@/features/purchases/requisitions/RequisitionListPage"),
);
const RequisitionCreatePage = lazy(
  () => import("@/features/purchases/requisitions/RequisitionCreatePage"),
);
const RequisitionRecordPage = lazy(
  () => import("@/features/purchases/requisitions/RequisitionRecordPage"),
);

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

        {/* Bill — create route (record form shell) */}
        <Route
          path="bills/new"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Bill">
                <BillCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        {/* Bill — object page (record shell) */}
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
        <Route
          path="rfqs/new"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="RFQ">
                <RFQCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="rfqs/:id/edit"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="RFQ">
                <RFQEditPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="rfqs/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="RFQ">
                <RFQRecordPage />
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

        {/* Goods Receipt — legacy capture route, forwards to WMS receiving */}
        <Route path="goods-receipt/new" element={<GoodsReceiptRedirect />} />

        {/* Landed Costs (ADR 0077) */}
        <Route
          path="landed-costs"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Landed Costs">
                <LandedCosts />
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
        <Route
          path="expenses/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Expense">
                <ExpenseCreatePage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="expenses/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Expense">
                <ExpenseEditPage />
              </LazyRoute>
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


        {/* Suppliers (P1 — canonical supplier master, Supplier 360) */}
        <Route
          path="suppliers"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Suppliers"><SupplierListPage /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="suppliers/new"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Supplier"><SupplierCreatePage /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="suppliers/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Supplier"><SupplierRecordPage /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Contracts (P2 — procurement contracts workbench) */}
        <Route
          path="contracts"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Contracts"><ContractListPage /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="contracts/new"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Contract"><ContractCreatePage /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="contracts/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Contract"><ContractRecordPage /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Requisitions (P3 — purchase requisitions workbench) */}
        <Route
          path="requisitions"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Requisitions"><RequisitionListPage /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="requisitions/new"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Requisition"><RequisitionCreatePage /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="requisitions/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Requisition"><RequisitionRecordPage /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Legacy /purchases/vendors retired in Batch K-Retire. Redirects to
            the canonical Supplier 360 workbench. */}
        <Route path="vendors" element={<Navigate to="/purchases/suppliers" replace />} />
        <Route path="vendors/*" element={<Navigate to="/purchases/suppliers" replace />} />

        
        
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
        <Route
          path="statements/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Vendor Statement">
                <VendorStatementRecordPage />
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

        {/* AP subledger ↔ control account reconciliation drill-down */}
        <Route
          path="ap-reconciliation"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="AP Reconciliation">
                <ApReconciliation />
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
