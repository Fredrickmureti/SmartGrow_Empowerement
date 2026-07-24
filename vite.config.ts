import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import path from "path";

// The Lovable sandbox / production build invokes the TanStack Start server
// entry (see src/server.ts + src/router.tsx). The `#tanstack-start-entry`
// package.json-imports alias that the start runtime resolves is injected by
// `@lovable.dev/vite-tanstack-config` — without this wrapper the dev server
// crashes with `Cannot find module '#tanstack-start-entry'`.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    base: process.env.ELECTRON_BUILD ? "./" : "/",
    server: {
      host: "::",
      port: 8080,
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  },
});
