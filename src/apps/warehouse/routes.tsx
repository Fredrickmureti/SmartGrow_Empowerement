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

const WarehouseOverview = lazy(() => import("@/pages/warehouse/WarehouseOverview"));
const InboundDashboard = lazy(() => import("@/pages/warehouse/InboundDashboard"));
const OutboundDashboard = lazy(() => import("@/pages/warehouse/OutboundDashboard"));
const WarehouseLayoutWorkspace = lazy(() => import("@/pages/warehouse/WarehouseLayoutWorkspace"));
const LayoutDesigner = lazy(() => import("@/pages/warehouse/LayoutDesigner"));
const LocationWorkspace = lazy(() => import("@/pages/warehouse/LocationWorkspace"));

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
const PutawayStrategies = lazy(() => import("@/pages/warehouse/PutawayStrategies"));
const WavePlanner = lazy(() => import("@/pages/warehouse/WavePlanner"));
const PickList = lazy(() => import("@/pages/warehouse/PickList"));
const PackStation = lazy(() => import("@/pages/warehouse/PackStation"));
const CycleCounts = lazy(() => import("@/pages/warehouse/CycleCounts"));
const CycleCountPlanner = lazy(() => import("@/pages/warehouse/CycleCountPlanner"));
const CountSession = lazy(() => import("@/pages/warehouse/CountSession"));
const CountTriggers = lazy(() => import("@/pages/warehouse/CountTriggers"));
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
const TrailerVisitWorkspace = lazy(() => import("@/pages/warehouse/TrailerVisitWorkspace"));
const YardControlTower = lazy(() => import("@/pages/warehouse/YardControlTower"));
const GateConsole = lazy(() => import("@/pages/warehouse/GateConsole"));
const TrailerRegister = lazy(() => import("@/pages/warehouse/TrailerRegister"));
const YardMarshal = lazy(() => import("@/pages/warehouse/YardMarshal"));
const LabourBoard = lazy(() => import("@/pages/warehouse/LabourBoard"));
const ExecutionTelemetry = lazy(() => import("@/pages/warehouse/ExecutionTelemetry"));
const BillingBoard = lazy(() => import("@/pages/warehouse/BillingBoard"));
const CrossdockBoard = lazy(() => import("@/pages/warehouse/CrossdockBoard"));
const PackagingCatalogue = lazy(() => import("@/pages/warehouse/PackagingCatalogue"));
const PackagingWorkspace = lazy(() => import("@/pages/warehouse/PackagingWorkspace"));
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
              <LazyRoute module="Warehouse Overview">
                <WarehouseOverview />
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
        {/* ADR 0102 — the supervisor tower merged into the Overview. Deep
            links preserved; there is exactly one command centre. */}
        <Route path="dashboard/supervisor" element={<Navigate to="/warehouse-app/dashboard" replace />} />


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

        {/* Location object page (ADR 0122) — the layout board previews a
            position; deep management lives on its own route. */}
        <Route
          path="layout/location/:id"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Location">
                <LocationWorkspace />
              </LazyRoute>
            </SubscriptionProtectedRoute>
          }
        />

        <Route
          path="layout/design"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Layout Designer">
                <LayoutDesigner />
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
          path="putaway/strategies"
          element={
            <SubscriptionProtectedRoute allowReadOnly>
              <LazyRoute module="Putaway strategies"><PutawayStrategies /></LazyRoute>
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
          path="counts/automation"
          element={
            <SubscriptionProtectedRoute>
              <LazyRoute module="Count Automation"><CountTriggers /></LazyRoute>
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
        <Route path="yard" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Yard & Trailers"><YardControlTower /></LazyRoute></SubscriptionProtectedRoute>} />
        {/* Yard visit object page (ADR 0122) — boards preview, workspace acts. */}
        <Route path="yard/visit/:id" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Trailer visit"><TrailerVisitWorkspace /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="yard/gate" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Gate Console"><GateConsole /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="yard/marshal" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Yard Marshal"><YardMarshal /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="yard/trailers" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Trailer Register"><TrailerRegister /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="labour" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Labour"><LabourBoard /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="telemetry" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Execution Telemetry"><ExecutionTelemetry /></LazyRoute></SubscriptionProtectedRoute>} />

        <Route path="billing" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="3PL Billing"><BillingBoard /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="crossdock" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Cross-dock"><CrossdockBoard /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="packaging" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Packaging catalogue"><PackagingCatalogue /></LazyRoute></SubscriptionProtectedRoute>} />
        {/* Packaging object page (ADR 0122) — catalogue previews, workspace edits. */}
        <Route path="packaging/:id" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Packaging"><PackagingWorkspace /></LazyRoute></SubscriptionProtectedRoute>} />
        {/* Legacy carton catalogue — superseded by the Packaging Master (ADR 0105). */}
        <Route path="cartons" element={<Navigate to="../packaging" replace />} />
        <Route path="exceptions" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Exceptions Inbox"><ExceptionsInbox /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="receiving" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Receiving Sessions"><ReceivingSessions /></LazyRoute></SubscriptionProtectedRoute>} />
        <Route path="returns" element={<SubscriptionProtectedRoute allowReadOnly><LazyRoute module="Return Orders"><ReturnOrders /></LazyRoute></SubscriptionProtectedRoute>} />




        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </WarehouseLayout>
  );
}

export default WarehouseApp;
