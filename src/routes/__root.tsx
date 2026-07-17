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
      { property: "og:title", content: "AccrualFlow — Modern Accounting Platform" },
      { name: "twitter:title", content: "AccrualFlow — Modern Accounting Platform" },
      { name: "description", content: "Your Daily Delight is a web application for managing and tracking inventory." },
      { property: "og:description", content: "Your Daily Delight is a web application for managing and tracking inventory." },
      { name: "twitter:description", content: "Your Daily Delight is a web application for managing and tracking inventory." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/6c462255-6ddb-4b75-8f5a-67dfbc40474c/id-preview-706e52df--3123bc35-d28d-4083-bc6a-4ffd633e7b80.lovable.app-1784252942790.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/6c462255-6ddb-4b75-8f5a-67dfbc40474c/id-preview-706e52df--3123bc35-d28d-4083-bc6a-4ffd633e7b80.lovable.app-1784252942790.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
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