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
 * Audit 2026-07-28 — surface consolidation:
 *   - `roles` (Printer roles) removed. Its bindings half wrote to
 *     `printer_role_branch_bindings`, a table dropped in migration
 *     20260727234102 along with `resolve_hardware_assignment`, so it was
 *     non-functional. The `printer_roles` dictionary it also edited is
 *     already surfaced as the role dropdown inside Output policies, which
 *     is where operators actually route documents. → redirects to policies.
 *   - `capability` (Printer capability) removed. Only `dpi` and
 *     `supported_media_ids` were read at runtime (label dispatch); those
 *     now live on the Devices page as `LabelMediaCapabilityCard`.
 *     `command_language` / `margins_mm` were never read. → redirects to devices.
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
const HardwareLabelTemplates = lazy(() => import("@/apps/platform/hardware/HardwareLabelTemplates"));
const HardwarePrintQueue = lazy(() => import("@/apps/platform/hardware/HardwarePrintQueue"));
const HardwarePolicies = lazy(() => import("@/apps/platform/hardware/HardwarePolicies"));


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
          {/* Retired surfaces — see header note. */}
          <Route path="capability" element={<Navigate to="../devices" replace />} />
          <Route path="roles" element={<Navigate to="../policies" replace />} />
          <Route path="labels" element={<HardwareLabelTemplates />} />
          <Route path="diagnostics" element={<HardwareDiagnostics />} />
          <Route path="print-queue" element={<HardwarePrintQueue />} />
          <Route path="policies" element={<HardwarePolicies />} />

          <Route path="topology" element={<HardwareTopology />} />
          <Route path="*" element={<Navigate to="devices" replace />} />
        </Routes>
      </Suspense>
    </HardwareAppLayout>
  );
}


export default PlatformHardwareApp;
