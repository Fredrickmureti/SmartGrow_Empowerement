// The @lovable.dev/vite-tanstack-config wrapper already provides: TanStack
// devtools (dev-only), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
// nitro (cloudflare target), VITE_* env injection, the "@" alias, React/TanStack
// dedupe, error-logger plugins and sandbox host/port detection. Do NOT re-add
// any of those here — duplicating them breaks the dev server on startup.
//
// M0 (stack repair) note: this file previously held the legacy SPA config
// (plain vite defineConfig + react-swc + vite-plugin-pwa). With that config the
// TanStack Start server entry was never registered, so every request 500'd with
// "Cannot find module '#tanstack-start-entry'".
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Route the bundled server entry through src/server.ts (SSR error wrapper).
    server: { entry: "server" },
  },
});
