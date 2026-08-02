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
const InboundDashboard = lazy(() => import("@/pages/warehouse/InboundDashboard"));
const OutboundDashboard = lazy(() => import("@/pages/warehouse/OutboundDashboard"));
const SupervisorDashboard = lazy(() => import("@/pages/warehouse/SupervisorDashboard"));
const WarehouseLayoutWorkspace = lazy(() => import("@/pages/warehouse/WarehouseLayoutWorkspace"));
// Warehouse master-data pages (ADR 0080). Warehouse app is the canonical
// author of `warehouses` rows; Inventory consumes read-only.
const Warehouses = lazy(() => import("@/pages/warehouse/WarehousesList"));
const WarehouseNew = lazy(() => import("@/pages/warehouse/WarehouseNew"));
const WarehouseEdit = lazy(() => import("@/pages/warehouse/WarehouseEdit"));
const WarehouseView = lazy(() => import("@/pages/warehouse/WarehouseView"));
const LicensePlates = lazy(() => import("@/pages/warehouse/LicensePlates"));
const LicensePlateView = lazy(() => import("@/pages/warehouse/LicensePlateView"));
const OperatorTasks = lazy(() => import("@/pages/warehouse/OperatorTasks"));
const MobileNextTask = lazy(() => import("@/pages/warehouse/MobileNextTask"));
const PutawayQueue = lazy(() => import("@/pages/warehouse/PutawayQueue"));
const WavePlanner = lazy(() => import("@/pages/warehouse/WavePlanner"));
const PickList = lazy(() => import("@/pages/warehouse/PickList"));
const PackStation = lazy(() => import("@/pages/warehouse/PackStation"));
const CycleCounts = lazy(() => import("@/pages/warehouse/CycleCounts"));
const CycleCountPlanner = lazy(() => import("@/pages/warehouse/CycleCountPlanner"));
const CountSession = lazy(() => import("@/pages/warehouse/CountSession"));
const CountReview = lazy(() => import("@/pages/warehouse/CountReview"));
const LoadingManifests = lazy(() => import("@/pages/warehouse/LoadingManifests"));
const LoadingManifestPlanner = lazy(() => import("@/pages/warehouse/LoadingManifestPlanner"));
const LoadingBay = lazy(() => import("@/pages/warehouse/LoadingBay"));
const DockSchedule = lazy(() => import("@/pages/warehouse/DockSchedule"));
const AppointmentPlanner = lazy(() => import("@/pages/warehouse/AppointmentPlanner"));
const QCQueue = lazy(() => import("@/pages/warehouse/QCQueue"));
const QCInspectionDetail = lazy(() => import("@/pages/warehouse/QCInspectionDetail"));
const Replenishment = lazy(() => import("@/pages/warehouse/Replenishment"));
const Slotting = lazy(() => import("@/pages/warehouse/Slotting"));
const YardBoard = lazy(() => import("@/pages/warehouse/YardBoard"));
const LabourBoard = lazy(() => import("@/pages/warehouse/LabourBoard"));
const BillingBoard = lazy(() => import("@/pages/warehouse/BillingBoard"));
const CrossdockBoard = lazy(() => import("@/pages/warehouse/CrossdockBoard"));
const CartonTypes = lazy(() => import("@/pages/warehouse/CartonTypes"));
const ExceptionsInbox = lazy(() => import("@/pages/warehouse/ExceptionsInbox"));
const ReceivingSessions = lazy(() => import("@/pages/warehouse/ReceivingSessions"));
const ReturnOrders = lazy(() => import("@/pages/warehouse/ReturnOrders"));


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
          path="dashboard/inbound"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Inbound Control Tower"><InboundDashboard /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="dashboard/outbound"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Outbound Control Tower"><OutboundDashboard /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="dashboard/supervisor"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Supervisor Control Tower"><SupervisorDashboard /></LazyRoute>
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
                <WarehouseLayoutWorkspace />
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
          path="mobile/next"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Next Task"><MobileNextTask /></LazyRoute>
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
        <Route
          path="waves"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Wave Planner"><WavePlanner /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="picks/:waveId"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Pick List"><PickList /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="pack/:waveId"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Pack Station"><PackStation /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route
          path="counts"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Cycle Counts"><CycleCounts /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="counts/new"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="New Cycle Count"><CycleCountPlanner /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="counts/:sessionId"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Count Session"><CountSession /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />
        <Route
          path="counts/:sessionId/review"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Count Review"><CountReview /></LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route path="dispatch" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Dispatch"><LoadingManifests /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="dispatch/new" element={<SubscriptionProtectedRoute><LazyRoute module="New Manifest"><LoadingManifestPlanner /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="dispatch/:manifestId" element={<SubscriptionProtectedRoute><LazyRoute module="Loading Bay"><LoadingBay /></LazyRoute></SubscriptionProtectedRoute>} />

        <Route path="schedule" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Dock Schedule"><DockSchedule /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="schedule/new" element={<SubscriptionProtectedRoute><LazyRoute module="Schedule Appointment"><AppointmentPlanner /></LazyRoute></SubscriptionProtectedRoute>} />

        <Route path="qc" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Quality Control"><QCQueue /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="qc/:id" element={<SubscriptionProtectedRoute><LazyRoute module="QC Inspection"><QCInspectionDetail /></LazyRoute></SubscriptionProtectedRoute>} />

        <Route path="replenishment" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Replenishment"><Replenishment /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="slotting" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Slotting"><Slotting /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="yard" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Yard & Trailers"><YardBoard /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="labour" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Labour"><LabourBoard /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="billing" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="3PL Billing"><BillingBoard /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="crossdock" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Cross-dock"><CrossdockBoard /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="cartons" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Carton catalogue"><CartonTypes /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="exceptions" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Exceptions Inbox"><ExceptionsInbox /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="receiving" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Receiving Sessions"><ReceivingSessions /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="returns" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Return Orders"><ReturnOrders /></LazyRoute></SubscriptionProtectedRoute>} />




        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </WarehouseLayout>
  );
}

export default WarehouseApp;
