/**
 * TanStack mirror for the SPA's `/scan/:token` route.
 *
 * Why: see ADR 0017 — the scanner pairing page is ERP-wide infrastructure
 * (Inventory, Sales, Purchases, POS all use it). It was previously only
 * mounted under `/pos/scan/:token`, which the POS subscription gate
 * redirected to `/dashboard` for non-POS tenants. The canonical URL now
 * lives at `/scan/:token`; this TanStack route keeps SSR/preview deployments
 * consistent with the SPA.
 *
 * Lazy-import inside `ClientOnly` because `MobileScannerPage` touches
 * `navigator`, `BarcodeDetector`, `localStorage`.
 */
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const MobileScannerPage = lazy(() => import("@/pages/pos/MobileScannerPage"));

export const Route = createFileRoute("/scan/$token")({
  head: () => ({
    meta: [{ title: "Pair scanner — AccrualFlow" }],
  }),
  component: ScanRoute,
});

function ScanRoute() {
  return (
    <ClientOnly fallback={<div style={{ padding: 24, fontFamily: "system-ui" }}>Loading scanner…</div>}>
      <Suspense fallback={<div style={{ padding: 24, fontFamily: "system-ui" }}>Loading scanner…</div>}>
        <MobileScannerPage />
      </Suspense>
    </ClientOnly>
  );
}
