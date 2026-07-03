/**
 * Inventory App Routes
 * 
 * Odoo-style: If the "inventory" app is enabled, ALL pages are accessible.
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SubscriptionProtectedRoute } from "@/components/subscription/SubscriptionProtectedRoute";
import { InventoryLayout } from "./InventoryLayout";

// Eager imports
import Products from "@/pages/Products";
const InventoryDashboard = lazy(() => import("@/pages/inventory/InventoryDashboard"));

// Lazy imports
const Inventory = lazy(() => import("@/pages/Inventory"));
const Warehouses = lazy(() => import("@/pages/Warehouses"));
const WarehouseNew = lazy(() => import("@/pages/inventory/WarehouseNew"));
const WarehouseEdit = lazy(() => import("@/pages/inventory/WarehouseEdit"));
const StockReports = lazy(() => import("@/pages/reports/StockReports"));
const InventoryValuationReport = lazy(() => import("@/pages/reports/InventoryValuationReport"));
const StockAgingReport = lazy(() => import("@/pages/reports/StockAgingReport"));
const ReplenishmentLog = lazy(() => import("@/pages/ReplenishmentLog"));
const ScrapRecording = lazy(() => import("@/pages/inventory/ScrapRecording"));
const ScrapNew = lazy(() => import("@/pages/inventory/ScrapNew"));
const PhysicalCount = lazy(() => import("@/pages/inventory/PhysicalCount"));
const Transfers = lazy(() => import("@/pages/inventory/Transfers"));
const TransferNew = lazy(() => import("@/pages/inventory/TransferNew"));
const Forecast = lazy(() => import("@/pages/inventory/Forecast"));
const BarcodeEnrollment = lazy(() => import("@/pages/inventory/BarcodeEnrollment"));
const UomManagement = lazy(() => import("@/pages/inventory/UomManagement"));
const AdjustmentNew = lazy(() => import("@/pages/inventory/AdjustmentNew"));

// Wrapper for lazy routes
const LazyRoute = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>
    {children}
  </Suspense>
);

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
        
        {/* Warehouses */}
        <Route
          path="warehouses"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Warehouses">
                <Warehouses />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Warehouse — routed create */}
        <Route
          path="warehouses/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Warehouse">
                <WarehouseNew />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        {/* Warehouse — routed edit */}
        <Route
          path="warehouses/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Warehouse">
                <WarehouseEdit />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        
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
