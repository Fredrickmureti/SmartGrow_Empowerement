import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useState } from "react";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";

const App = lazy(() => import("@/App"));

export const Route = createFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div id="app-root" suppressHydrationWarning>
      {mounted ? (
        <Suspense fallback={<RouteLoadingFallback />}>
          <App />
        </Suspense>
      ) : (
        <RouteLoadingFallback />
      )}
    </div>
  );
}
