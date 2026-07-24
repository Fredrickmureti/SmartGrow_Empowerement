import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import type { PluginOption } from "vite";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

const isDev = process.env.NODE_ENV !== "production";

// The Lovable sandbox / production build invokes the TanStack Start server
// entry (see src/server.ts + src/router.tsx). The `#tanstack-start-entry`
// package.json-imports alias that the start runtime resolves is injected by
// `@lovable.dev/vite-tanstack-config` — without this wrapper the dev server
// crashes with `Cannot find module '#tanstack-start-entry'`.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  plugins: [
    react() as PluginOption,
    isDev ? (componentTagger() as unknown as PluginOption) : null,
    process.env.ELECTRON_BUILD
      ? (VitePWA({ disable: true }) as unknown as PluginOption)
      : (VitePWA({
          registerType: "autoUpdate",
          includeAssets: ["favicon.ico", "pwa-192x192.png", "pwa-512x512.png"],
          manifest: {
            name: "AccrualFlow - Business Management Platform",
            short_name: "AccrualFlow",
            description:
              "Professional invoicing, expense tracking, and financial management for modern businesses",
            theme_color: "#3b82f6",
            background_color: "#000000",
            display: "standalone",
            orientation: "portrait",
            scope: "/",
            start_url: "/home",
            categories: ["business", "finance", "productivity"],
            icons: [
              {
                src: "/favicon.svg",
                sizes: "any",
                type: "image/svg+xml",
                purpose: "any",
              },
            ],
          },
          workbox: {
            globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
            maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
            runtimeCaching: [
              {
                urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
                handler: "NetworkFirst",
                options: {
                  cacheName: "supabase-cache",
                  expiration: {
                    maxEntries: 50,
                    maxAgeSeconds: 60 * 60 * 24,
                  },
                  cacheableResponse: { statuses: [0, 200] },
                },
              },
            ],
          },
          devOptions: { enabled: false },
        }) as unknown as PluginOption),
  ].filter(Boolean) as PluginOption[],
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
