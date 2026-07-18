/**
 * POS App Routes
 * 
 * Defines all routes within the POS app module.
 */

import { Routes, Route, Navigate } from "react-router-dom";
import { Suspense, lazy, type ComponentType } from "react";
import { POSShellLayout } from "./POSShellLayout";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { RequireActiveBusinessRoute } from "@/components/common/RequireActiveBusinessRoute";
import { POSErrorBoundary } from "@/components/pos/POSErrorBoundary";
import POSDashboard from "@/pages/pos/POS";
import POSReports from "@/pages/pos/POSReports";
import POSSettings from "@/pages/pos/POSSettings";

// Core workspace destinations are eager on purpose. React Router can update
// the URL before a lazy route transition commits; if the next POS page
// suspends, React keeps the previous Settings tree visible. Dashboard,
// Reports, and Settings are top-nav destinations and must switch without a
// chunk-load suspension. Standalone/heavy surfaces stay lazy below.
const POSTerminal = lazy(() => import("@/pages/pos/POSTerminal"));
const FloorPlan = lazy(() => import("@/pages/pos/FloorPlan"));
const KitchenDisplay = lazy(() => import("@/pages/pos/KitchenDisplay"));
const TableBookings = lazy(() => import("@/pages/pos/TableBookings"));
const CustomerDisplay = lazy(() => import("@/pages/pos/CustomerDisplay"));
const MobileScannerPage = lazy(() => import("@/pages/pos/MobileScannerPage"));
/**
 * Resilient lazy wrapper: if the chunk fails to download (very common under
 * Electron's `file://` if a chunk path escapes the asar or the renderer
 * evaluation throws), the import promise is converted into a visible error
 * card instead of an indefinite Suspense fallback or a silent white page.
 * The POSShellErrorBoundary above this still catches in-component renders;
 * this catches the module-load step before the boundary even mounts.
 */
function resilientLazy<T extends ComponentType<unknown>>(
  loader: () => Promise<{ default: T }>,
  name: string,
) {
  return lazy(() =>
    loader()
      .then((mod) => {
        // A module that loads but exports `undefined` (e.g. an evaluation
        // error during ESM init that produced an empty default) causes
        // React to render nothing — i.e. a blank screen. Convert that
        // into a real rejection so the .catch() below paints the
        // diagnostic card instead.
        if (!mod || typeof (mod as { default?: unknown }).default !== 'function') {
          throw new Error(
            `${name} module loaded without a valid default export — likely a module-evaluation error.`,
          );
        }
        return mod;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[pos-routes] lazy chunk failed: ${name}`, err);
        const Fallback: ComponentType<unknown> = () => (
          <div className="p-6">
            <div className="rounded border border-destructive/40 bg-destructive/5 p-4">
              <h2 className="font-semibold mb-2">{name} failed to load</h2>
              <p className="text-sm text-muted-foreground">
                The page could not be loaded. This usually means the application
                bundle is out of date. Please reload the desktop app.
              </p>
              <pre className="text-xs mt-3 whitespace-pre-wrap">{String(err?.message ?? err)}</pre>
            </div>
          </div>
        );
        return { default: Fallback as unknown as T };
      }),
  );
}
const PosTerminalsPage = lazy(() => import("@/pages/pos/PosTerminalsPage"));
const ScannerTelemetry = lazy(() => import("@/pages/pos/ScannerTelemetry"));
const CardSettlementReport = lazy(() => import("@/pages/pos/CardSettlementReport"));

/**
 * POS app routing tree.
 *
 * Architectural notes (see docs/audit/2026-05-20-pos-routing-lifecycle.md):
 *
 * - Standalone routes (terminal, customer-display, mobile scanner) sit
 *   OUTSIDE the shell layout and use their own top-level <Suspense> so
 *   their lazy chunks don't perturb the POS shell tree.
 *
 * - Every workspace route shares a single stable layout-route element
 *   (`POSShellLayout`). The Suspense boundary that covers lazy
 *   page chunks is INSIDE that shell — so navigating Settings → Reports
 *   only swaps the page content, not the top nav / providers / badges.
 *   That was the source of the "URL changes but UI stays on Settings"
 *   beat: the entire shell was unmounting to a fallback every nav.
 */
function POSApp() {
  return (
    <Routes>
      {/* Standalone full-screen routes. Each gets its own Suspense so
          their lazy chunks don't unmount the workspace shell. */}
      <Route
        path="terminal/:registerId"
        element={
          <RequireActiveBusinessRoute>
            <POSErrorBoundary>
              <Suspense fallback={<RouteLoadingFallback module="POS" />}>
                <POSTerminal />
              </Suspense>
            </POSErrorBoundary>
          </RequireActiveBusinessRoute>
        }
      />
      <Route
        path="customer-display"
        element={
          <Suspense fallback={<RouteLoadingFallback module="POS" />}>
            <CustomerDisplay />
          </Suspense>
        }
      />
      <Route
        path="scan/:token"
        element={
          <Suspense fallback={<RouteLoadingFallback module="POS" />}>
            <MobileScannerPage />
          </Suspense>
        }
      />

      {/* Workspace shell — stable element, Suspense lives inside. */}
      <Route element={<POSShellLayout />}>
        <Route index element={<POSDashboard />} />
        <Route path="floor-plan" element={<FloorPlan />} />
        <Route path="floor-plan/:registerId" element={<FloorPlan />} />
        <Route path="kitchen" element={<KitchenDisplay />} />
        <Route path="bookings" element={<TableBookings />} />
        <Route path="reports" element={<POSReports />} />
        <Route path="settlements" element={<CardSettlementReport />} />
        <Route path="settings" element={<POSSettings />} />
        {/* Wave 9b: hardware pages moved to /platform/hardware/*. App.tsx
            still maps the legacy /pos/hardware-* URLs via <Navigate>. */}
        <Route path="payment-terminals" element={<PosTerminalsPage />} />
        <Route path="scanner-telemetry" element={<ScannerTelemetry />} />
      </Route>

      <Route path="*" element={<Navigate to="/pos" replace />} />
    </Routes>
  );
}

export default POSApp;
