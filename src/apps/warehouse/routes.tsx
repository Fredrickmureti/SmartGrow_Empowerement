/**
 * Warehouse App Routes (Phase 0 scaffold — ADR 0079).
 *
 * Only Warehouses master, Layout tree, and a Dashboard are wired in
 * Phase 0. Every other nav item routes to a "coming online" placeholder
 * so that operators, planners, and product can see the target topology
 * and give feedback before we cut the receiving/putaway/picking domains.
 */
import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { SubscriptionProtectedRoute } from "@/components/subscription/SubscriptionProtectedRoute";
import { WarehouseLayout } from "./WarehouseLayout";
import { WmsComingSoon } from "@/pages/warehouse/WmsComingSoon";

const WarehouseDashboard = lazy(() => import("@/pages/warehouse/WarehouseDashboard"));
const WarehouseLayoutPage = lazy(() => import("@/pages/warehouse/WarehouseLayoutPage"));
// Reuse existing Inventory-authored screens for CRUD until WMS-native
// versions ship in a later phase. Redirect layer preserves deep links.
const Warehouses = lazy(() => import("@/pages/Warehouses"));
const WarehouseNew = lazy(() => import("@/pages/inventory/WarehouseNew"));
const WarehouseEdit = lazy(() => import("@/pages/inventory/WarehouseEdit"));
const WarehouseView = lazy(() => import("@/pages/inventory/WarehouseView"));

const LazyRoute = ({ children, module }: { children: React.ReactNode; module?: string }) => (
  <Suspense fallback={<RouteLoadingFallback module={module} />}>{children}</Suspense>
);

const soon = (title: string, phase: string) => (
  <WmsComingSoon title={title} phase={phase} />
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

        {/* Warehouses master (subsumed from /inventory-app/warehouses). */}
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

        {/* Layout: zone / aisle / rack / shelf / bin tree editor. */}
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

        {/* Placeholders — surface the target topology while the underlying
            domains are being built out in later phases. */}
        <Route path="receiving" element={soon("Receiving", "Phase 2 — appointments, dock schedule, unload → inspect → GRN")} />
        <Route path="putaway"   element={soon("Put-away",   "Phase 3 — directed put-away tasks with operator scan-to-confirm")} />
        <Route path="tasks"     element={soon("Operator tasks", "Phase 1 — universal operator queue (pick / pack / load / count)")} />
        <Route path="picking"   element={soon("Picking",   "Phase 4 — waves, batch/cluster/discrete strategies, pick path")} />
        <Route path="packing"   element={soon("Packing",   "Phase 4 — pack stations, cartonization, shipment packages")} />
        <Route path="dispatch"  element={soon("Dispatch",  "Phase 5 — loading manifests, dock-out appointments")} />
        <Route path="qc"        element={soon("Quality control", "Phase 6 — QC inspection lots with release / quarantine / scrap dispositions")} />
        <Route path="plates"    element={soon("License plates",  "Phase 1 — LPN registry (pallet / carton / tote)")} />
        <Route path="operators" element={soon("Operators", "Phase 7 — WMS role assignment, shift binding, productivity ledger")} />

        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </WarehouseLayout>
  );
}

export default WarehouseApp;
