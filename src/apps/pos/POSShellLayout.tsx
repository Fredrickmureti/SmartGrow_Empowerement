/**
 * POSShellLayout
 *
 * Stable RR6 layout-route element for every non-standalone POS route.
 * Two reasons this exists as its own component instead of being inlined
 * as `element={<POSLayout><Outlet/></POSLayout>}`:
 *
 *   1. **Stable element identity.** Inlining recreates the React element
 *      on every render of the parent `<Routes>`, which combined with
 *      AppWorkspaceLayout's early-return branches can cause subtree
 *      remounts that strand in-flight Suspense work.
 *
 *   2. **Local Suspense boundary.** When the user navigates between POS
 *      subroutes (Settings → Reports, etc.), the lazy chunk for the
 *      next page suspends. If the only `<Suspense>` boundary sits ABOVE
 *      the layout, the entire POS shell (top nav, providers, badges)
 *      unmounts to a fallback and then remounts — which is what makes
 *      "the UI looks stuck on Settings for a beat, then snaps". Keeping
 *      Suspense inside the shell means only the page content swaps.
 *
 * See docs/audit/2026-05-20-pos-routing-lifecycle.md for the full audit
 * and rejected-hypothesis notes.
 */
import { Suspense } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import { POSLayout } from "./POSLayout";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { POSShellErrorBoundary } from "@/components/pos/POSShellErrorBoundary";
import { usePOSContextReady } from "@/hooks/pos/usePOSContextReady";

export function POSShellLayout() {
  const { pathname } = useLocation();
  const outlet = useOutlet();
  const { ready } = usePOSContextReady();
  const sub = pathname.split("/")[2] ?? "";
  const outletKey = `pos:${sub}`;

  // Gate the entire POS subtree on the conjunction of every branch-critical
  // dependency (auth, org, company, branch). While these dependencies are
  // being resolved we intentionally DO NOT mount `POSLayout` (which
  // includes header badges like `ActiveBranchBadge`) to avoid any
  // transient UI flashes such as a destructive "No branch selected".
  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <RouteLoadingFallback module="POS" />
      </div>
    );
  }

  return (
    <POSLayout>
      <Suspense fallback={<RouteLoadingFallback module="POS" />}>
        <POSShellErrorBoundary resetKey={outletKey}>
          <div key={outletKey}>{outlet}</div>
        </POSShellErrorBoundary>
      </Suspense>
    </POSLayout>
  );
}

export default POSShellLayout;
