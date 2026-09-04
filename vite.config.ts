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

// Deploy target: the Lovable sandbox always builds for Cloudflare. On Vercel
// (VERCEL=1 during the build) we build with nitro's `vercel` preset so the
// output lands in .vercel/output (Build Output API v3) with SSR + assets wired
// up. Without this, Vercel published only dist/ (client + worker) and every
// request fell through to an HTML 404, which is why module scripts failed the
// strict MIME check and the page rendered blank.
export default defineConfig({
  ...(process.env.VERCEL ? { nitro: { preset: "vercel" } } : {}),
  tanstackStart: {
    // Route the bundled server entry through src/server.ts (SSR error wrapper).
    server: { entry: "server" },
  },
});
