import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // Electron loads index.html via file:// — relative base is required.
  // The packaging driver sets ELECTRON_BUILD=1 before invoking `vite build`.
  base: process.env.ELECTRON_BUILD ? './' : '/',
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    // Provides TanStack Start's virtual client/server entries used by the
    // Lovable preview dev shell (`#tanstack-start-entry`).
    ...tanstackStart(),
    // Generates src/routeTree.gen.ts from files in src/routes/. Required by
    // the Lovable sandbox dev shell which serves the app via TanStack Start.
    // The actual ERP UI is rendered by react-router-dom inside <App />.
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }) as unknown as PluginOption,
    react(),
    mode === "development" ? (componentTagger() as unknown as PluginOption) : null,
    // Service worker is disabled for Electron packaged builds — `file://`
    // is not a secure context for SW registration and adds runtime errors
    // with no benefit. Desktop offline lives in pos.offline.* (preload).
    process.env.ELECTRON_BUILD ? VitePWA({ disable: true }) : VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        name: 'AccrualFlow - Business Management Platform',
        short_name: 'AccrualFlow',
        description: 'Professional invoicing, expense tracking, and financial management for modern businesses',
        theme_color: '#3b82f6',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/home',
        categories: ['business', 'finance', 'productivity'],
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any'
          }
        ],
        shortcuts: [
          {
            name: 'Finance & Accounting',
            short_name: 'Finance',
            description: 'Manage accounts, invoices, and financial reports',
            url: '/finance/accounts',
            icons: [{ src: '/icons/finance-96.svg', sizes: '96x96', type: 'image/svg+xml' }]
          },
          {
            name: 'Point of Sale',
            short_name: 'POS',
            description: 'Process sales and manage transactions',
            url: '/pos',
            icons: [{ src: '/icons/pos-96.svg', sizes: '96x96', type: 'image/svg+xml' }]
          },
          {
            name: 'Sales & CRM',
            short_name: 'Sales',
            description: 'Manage customers and sales orders',
            url: '/sales/orders',
            icons: [{ src: '/icons/sales-96.svg', sizes: '96x96', type: 'image/svg+xml' }]
          },
          {
            name: 'Inventory',
            short_name: 'Inventory',
            description: 'Track products and stock levels',
            url: '/inventory/products',
            icons: [{ src: '/icons/inventory-96.svg', sizes: '96x96', type: 'image/svg+xml' }]
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MiB limit
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 // 24 hours
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      },
      devOptions: {
        enabled: false // Disable in dev to avoid conflicts
      }
    }) as unknown as PluginOption,
  ].filter(Boolean) as PluginOption[],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
