/**
 * Mobile warehouse (RF) route tree — Phase 13.
 * Mounted under /wm.
 */
import { Routes, Route, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";

const MobileHome = lazy(() => import("@/pages/warehouse-mobile/MobileHome"));
const MobilePutaway = lazy(() => import("@/pages/warehouse-mobile/MobilePutaway"));
const MobilePick = lazy(() => import("@/pages/warehouse-mobile/MobilePick"));
const MobileCount = lazy(() => import("@/pages/warehouse-mobile/MobileCount"));
const MobileReceive = lazy(() => import("@/pages/warehouse-mobile/MobileReceive"));
const MobileReceivingSessions = lazy(
  () => import("@/pages/warehouse-mobile/MobileReceiveSession"),
);
const MobileReceiveSession = lazy(() =>
  import("@/pages/warehouse-mobile/MobileReceiveSession").then((m) => ({
    default: m.MobileReceiveSession,
  })),
);

const MobilePack = lazy(() => import("@/pages/warehouse-mobile/MobilePack"));
const MobileDispatch = lazy(() => import("@/pages/warehouse-mobile/MobileDispatch"));
const MobileQC = lazy(() => import("@/pages/warehouse-mobile/MobileQC"));
const MobilePlateLookup = lazy(() => import("@/pages/warehouse-mobile/MobilePlate"));
const MobilePlateDetail = lazy(() =>
  import("@/pages/warehouse-mobile/MobilePlate").then((m) => ({ default: m.MobilePlateDetail })),
);

export default function WarehouseMobileApp() {
  return (
    <Suspense fallback={<div className="p-6 text-sm">Loading…</div>}>
      <Routes>
        <Route index element={<MobileHome />} />
        <Route path="putaway/:id" element={<MobilePutaway />} />
        <Route path="pick/:id" element={<MobilePick />} />
        <Route path="count/:id" element={<MobileCount />} />
        <Route path="receive/:id" element={<MobileReceive />} />
        <Route path="pack/:packId" element={<MobilePack />} />
        <Route path="dispatch/:shipmentId" element={<MobileDispatch />} />
        <Route path="qc/:taskId" element={<MobileQC />} />
        <Route path="plate" element={<MobilePlateLookup />} />
        <Route path="plate/:id" element={<MobilePlateDetail />} />
        <Route path="*" element={<Navigate to="/wm" replace />} />
      </Routes>
    </Suspense>
  );
}
