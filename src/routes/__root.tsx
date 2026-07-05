/**
 * Root TanStack route — provides the HTML shell expected by TanStack Start's
 * SSR entry. The actual application providers (Auth, Business, Branch, Query,
 * etc.) live inside `<App />` in src/App.tsx, which is mounted by the index
 * route. Keeping this shell intentionally thin avoids double-providing
 * QueryClientProvider or stomping on the SPA's BrowserRouter.
 */
import type { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

// The TanStack Start plugin owns the SSR/client entry (see src/router.tsx),
// so `src/main.tsx` never executes in this runtime. Import the global
// stylesheet here so Vite registers it as a CSS asset of the __root route
// and the Start plugin emits the `<link rel="stylesheet">` — otherwise the
// entire app renders unstyled.
import "../index.css";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AccrualFlow — Modern Accounting Platform" },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>404 — Page Not Found</h1>
    </div>
  ),
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

// Component is required by createRootRouteWithContext for client rendering.
(Route as any).options.component = () => <Outlet />;