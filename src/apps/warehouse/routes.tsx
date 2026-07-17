/**
 * Warehouse App Routes (ADR 0079).
 *
 * Only routes with real, functional pages are wired. Do not add routes
 * that render placeholders — build the domain first, then wire it.
 */
import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SubscriptionProtectedRoute } from "@/components/subscription/SubscriptionProtectedRoute";
import { WarehouseLayout } from "./WarehouseLayout";

const WarehouseDashboard = lazy(() => import("@/pages/warehouse/WarehouseDashboard"));
const WarehouseLayoutPage = lazy(() => import("@/pages/warehouse/WarehouseLayoutPage"));
// Reuse existing Inventory-authored CRUD screens for the warehouse master
// until a WMS-native detail replaces them. They already read/write
// `warehouses` cleanly and respect business/branch scope.
const Warehouses = lazy(() => import("@/pages/Warehouses"));
const WarehouseNew = lazy(() => import("@/pages/inventory/WarehouseNew"));
const WarehouseEdit = lazy(() => import("@/pages/inventory/WarehouseEdit"));
const WarehouseView = lazy(() => import("@/pages/inventory/WarehouseView"));
const LicensePlates = lazy(() => import("@/pages/warehouse/LicensePlates"));
const LicensePlateView = lazy(() => import("@/pages/warehouse/LicensePlateView"));
const OperatorTasks = lazy(() => import("@/pages/warehouse/OperatorTasks"));
const PutawayQueue = lazy(() => import("@/pages/warehouse/PutawayQueue"));

const LazyRoute = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>{children}</Suspense>
);

export function WarehouseApp() {
  return (
    <WarehouseLayout>
      <Routes>
        <Route index element={<Navigate to="dashboard" replace />} />

        <Route
          path="dashboard"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Warehouse Dashboard">
                <WarehouseDashboard />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route
          path="warehouses"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Warehouses"><Warehouses /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="warehouses/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Warehouse"><WarehouseNew /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="warehouses/:id/edit"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Edit Warehouse"><WarehouseEdit /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="warehouses/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Warehouse"><WarehouseView /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route
          path="layout"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Warehouse Layout">
                <WarehouseLayoutPage />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route
          path="plates"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="License Plates"><LicensePlates /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="plates/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="License Plate"><LicensePlateView /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="tasks"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Operator Tasks"><OperatorTasks /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="putaway"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Putaway"><PutawayQueue /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </WarehouseLayout>
  );
}

export default WarehouseApp;
