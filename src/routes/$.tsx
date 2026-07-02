/**
 * Catch-all route — bridges every non-TanStack URL into the legacy
 * react-router-dom SPA mounted by src/App.tsx.
 *
 * Why this exists:
 *  - Only `/` is currently a TanStack route. The legacy SPA owns dozens of
 *    deep paths (/hr, /finance/..., /sales/...). Without a catch-all,
 *    TanStack Router returns its own not-found for any direct load or
 *    hard refresh outside `/`, even though the SPA can handle them.
 *  - Mounting <App /> here lets BrowserRouter inside the SPA see the real
 *    URL and resolve the correct screen.
 *
 * Why client-only:
 *  - App.tsx pulls in BrowserRouter, Sentry, Supabase, framer-motion and
 *    ~60 other browser-only modules at evaluation time. Importing it
 *    during SSR crashes the prerender. The mounted-on-client guard
 *    matches src/routes/index.tsx.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useState } from "react";

const App = lazy(() => import("@/App"));

export const Route = createFileRoute("/$")({
  component: CatchAllRoute,
});

function CatchAllRoute() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <App />
    </Suspense>
  );
}
