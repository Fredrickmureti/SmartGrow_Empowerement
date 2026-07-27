/**
 * Platform Hardware Routes — Wave 5 (Phase 3).
 *
 * Lifts the hardware management surface out of POS into a platform-owned
 * tree. The pages themselves are unchanged renderers (re-exported from
 * `src/pages/pos/*`); the data source is the canonical, tenant-scoped
 * `device_assignments` table via `useDeviceAssignments`, so any module
 * (Inventory, Warehouse, HR, Manufacturing) can consume the same registry
 * without depending on POS being installed.
 *
 * Legacy `/pos/hardware-devices` and `/pos/hardware-diagnostics` paths
 * still resolve via redirects in `src/App.tsx`.
 */
import { Routes, Route, Navigate } from "react-router-dom";
import { Suspense, lazy } from "react";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";

const HardwareDevices = lazy(() => import("@/apps/platform/hardware/HardwareDevices"));
const HardwareDiagnostics = lazy(() => import("@/apps/platform/hardware/HardwareDiagnostics"));
const HardwareTopology = lazy(() => import("@/apps/platform/hardware/HardwareTopology"));
const HardwareMedia = lazy(() => import("@/apps/platform/hardware/HardwareMedia"));
const HardwareCapability = lazy(() => import("@/apps/platform/hardware/HardwareCapability"));
const HardwareLabelTemplates = lazy(() => import("@/apps/platform/hardware/HardwareLabelTemplates"));
const HardwarePrintQueue = lazy(() => import("@/apps/platform/hardware/HardwarePrintQueue"));
const HardwarePolicies = lazy(() => import("@/apps/platform/hardware/HardwarePolicies"));
const HardwareRoles = lazy(() => import("@/apps/platform/hardware/HardwareRoles"));


import HardwareAppLayout from "@/apps/platform/hardware/HardwareAppLayout";

function PlatformHardwareApp() {
  return (
    <HardwareAppLayout>
      <Suspense fallback={<RouteLoadingFallback module="Hardware" />}>
        <Routes>
          <Route index element={<Navigate to="devices" replace />} />
          <Route path="devices" element={<HardwareDevices />} />
          {/* Legacy `/devices/new` wizard retired — the mature
              `HardwareDevices` page hosts the single registration
              surface (DeviceRegistryCard). Redirect any bookmarks. */}
          <Route path="devices/new" element={<Navigate to="../devices" replace />} />
          <Route path="media" element={<HardwareMedia />} />
          <Route path="capability" element={<HardwareCapability />} />
          <Route path="labels" element={<HardwareLabelTemplates />} />
          <Route path="diagnostics" element={<HardwareDiagnostics />} />
          <Route path="print-queue" element={<HardwarePrintQueue />} />
          <Route path="policies" element={<HardwarePolicies />} />
          <Route path="roles" element={<HardwareRoles />} />

          <Route path="topology" element={<HardwareTopology />} />
          <Route path="*" element={<Navigate to="devices" replace />} />
        </Routes>
      </Suspense>
    </HardwareAppLayout>
  );
}


export default PlatformHardwareApp;
