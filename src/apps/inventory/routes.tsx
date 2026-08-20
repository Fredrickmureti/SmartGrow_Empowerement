/**
 * Inventory App Routes
 * 
 * Odoo-style: If the "inventory" app is enabled, ALL pages are accessible.
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SubscriptionProtectedRoute } from "@/components/subscription/SubscriptionProtectedRoute";
import { InventoryLayout } from "./InventoryLayout";

// Eager imports
import Products from "@/pages/Products";
const InventoryDashboard = lazy(() => import("@/pages/inventory/InventoryDashboard"));

// Lazy imports
const Inventory = lazy(() => import("@/pages/Inventory"));
// Warehouse master data now owned by the Warehouse app (ADR 0080).
// Inventory keeps deep-link parity via <Navigate> below.
const StockReports = lazy(() => import("@/pages/reports/StockReports"));
const InventoryValuationReport = lazy(() => import("@/pages/reports/InventoryValuationReport"));
const StockAgingReport = lazy(() => import("@/pages/reports/StockAgingReport"));
const LotTraceabilityReport = lazy(() => import("@/pages/reports/LotTraceabilityReport"));
const StockLedgerReport = lazy(() => import("@/pages/reports/StockLedgerReport"));
const InventoryIntegrity = lazy(() => import("@/pages/inventory/InventoryIntegrity"));

const ReplenishmentLog = lazy(() => import("@/pages/ReplenishmentLog"));
const AutoPoLog = lazy(() => import("@/pages/inventory/AutoPoLog"));
const ScrapRecording = lazy(() => import("@/pages/inventory/ScrapRecording"));
const ScrapNew = lazy(() => import("@/pages/inventory/ScrapNew"));
const ScrapReasons = lazy(() => import("@/pages/inventory/setup/ScrapReasons"));
const PhysicalCount = lazy(() => import("@/pages/inventory/PhysicalCount"));
const PhysicalCountWorkspace = lazy(() => import("@/pages/inventory/PhysicalCountWorkspace"));
const PhysicalCountDetail = lazy(() => import("@/pages/inventory/PhysicalCountDetail"));
const CycleCountSchedules = lazy(() => import("@/pages/inventory/CycleCountSchedules"));
const Transfers = lazy(() => import("@/pages/inventory/Transfers"));
const TransferNew = lazy(() => import("@/pages/inventory/TransferNew"));
const Forecast = lazy(() => import("@/pages/inventory/Forecast"));
const BarcodeEnrollment = lazy(() => import("@/pages/inventory/BarcodeEnrollment"));
const UomManagement = lazy(() => import("@/pages/inventory/UomManagement"));
const AdjustmentNew = lazy(() => import("@/pages/inventory/AdjustmentNew"));
const ProductNew = lazy(() => import("@/pages/inventory/ProductNew"));
const ProductEdit = lazy(() => import("@/pages/inventory/ProductEdit"));
const InboundShipments = lazy(() => import("@/pages/inventory/InboundShipments"));
const InboundShipmentDetail = lazy(() => import("@/pages/inventory/InboundShipmentDetail"));
const Lots = lazy(() => import("@/pages/inventory/Lots"));
const LotDetail = lazy(() => import("@/pages/inventory/LotDetail"));
const LabelOperations = lazy(() => import("@/pages/inventory/LabelOperations"));

// Wrapper for lazy routes
const LazyRoute = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>
    {children}
  </Suspense>
);

// Deep-link redirects for the retired /inventory-app/warehouses/* surface (ADR 0080).
function InventoryWarehouseViewRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/warehouse-app/warehouses/${id}`} replace />;
}
function InventoryWarehouseEditRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/warehouse-app/warehouses/${id}/edit`} replace />;
}

/**
 * Inventory App Component
 */
export function InventoryApp() {
  return (
    <InventoryLayout>
      <Routes>
        {/* Default redirect to dashboard */}
        <Route index element={<Navigate to="dashboard" replace />} />
        
        {/* Inventory Dashboard */}
        <Route
          path="dashboard"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Inventory Dashboard">
                <InventoryDashboard />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Products */}
        <Route
          path="products"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <Products />
            </SubscriptionProtectedRoute>
          }
        />

        {/* Product create / edit — routed RecordFormShell (replaces legacy inline dialog). */}
        <Route
          path="products/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Add Product">
                <ProductNew />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="products/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Product">
                <ProductEdit />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Barcode Enrollment Workspace — scanner-first bulk assignment */}
        <Route
          path="products/enroll"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Barcode Enrollment">
                <BarcodeEnrollment />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />



        
        {/* Stock Levels */}
        <Route
          path="stock"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Inventory">
                <Inventory />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Warehouses — ownership moved to Warehouse app per ADR 0080.
            Preserve deep links from bookmarks / older Inventory nav. */}
        <Route path="warehouses" element={<Navigate to="/warehouse-app/warehouses" replace />} />
        <Route path="warehouses/new" element={<Navigate to="/warehouse-app/warehouses/new" replace />} />
        <Route path="warehouses/:id/edit" element={<InventoryWarehouseEditRedirect />} />
        <Route path="warehouses/:id" element={<InventoryWarehouseViewRedirect />} />


        
        {/* Replenishment */}
        <Route
          path="replenishment"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Replenishment">
                <ReplenishmentLog />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Auto-PO log — archival */}
        <Route
          path="replenishment/auto-po-log"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Auto-PO Log">
                <AutoPoLog />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Transfers */}
        <Route
          path="transfers"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Stock Transfers">
                <Transfers />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Stock Transfer — routed create */}
        <Route
          path="transfers/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Stock Transfer">
                <TransferNew />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Forecast */}
        <Route
          path="forecast"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Inventory Forecast">
                <Forecast />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Scrap Recording */}
        <Route
          path="scrap"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Scrap Recording">
                <ScrapRecording />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Scrap Recording — routed create */}
        <Route
          path="scrap/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Record Scrap">
                <ScrapNew />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Scrap reasons — master data */}
        <Route
          path="setup/scrap-reasons"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Scrap Reasons">
                <ScrapReasons />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />


        {/* Stock Adjustment — routed create */}
        <Route
          path="adjustments/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Stock Adjustment">
                <AdjustmentNew />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Inbound Shipments (ASN) */}
        <Route
          path="inbound-shipments"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Inbound Shipments">
                <InboundShipments />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="inbound-shipments/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Inbound Shipment">
                <InboundShipmentDetail />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Lots & Traceability (ADR 0070) */}
        <Route
          path="lots"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Lots">
                <Lots />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="lots/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Lot Detail">
                <LotDetail />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        {/* Label Operations Engine — demand queue + server-owned print runs */}
        <Route
          path="labels"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Label Operations">
                <LabelOperations />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Physical Count */}
        <Route
          path="count"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Physical Count">
                <PhysicalCount />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="physical-counts"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Physical Count Workspace">
                <PhysicalCountWorkspace />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="physical-counts/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Physical Count Detail">
                <PhysicalCountDetail />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="cycle-schedules"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Cycle Count Schedules">
                <CycleCountSchedules />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
        
        {/* Stock Reports */}
        <Route
          path="reports"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Stock Reports">
                <StockReports />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Inventory Valuation Report */}
        <Route
          path="reports/valuation"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Inventory Valuation">
                <InventoryValuationReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Stock Ledger (quantity ledger) — Phase 4 */}
        <Route
          path="reports/ledger"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Stock Ledger">
                <StockLedgerReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Stock Aging Report */}
        <Route
          path="reports/aging"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Stock Aging">
                <StockAgingReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Lot / serial traceability — Phase 7 */}
        <Route
          path="reports/lot-traceability"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Lot Traceability">
                <LotTraceabilityReport />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Ledger integrity report (ADR 0142 Phase 3) */}
        <Route
          path="reports/integrity"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Inventory Integrity">
                <InventoryIntegrity />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        
        {/* Units of Measure management */}
        <Route
          path="uom"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Units of Measure">
                <UomManagement />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Catch all */}
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </InventoryLayout>
  );
}

export default InventoryApp;
