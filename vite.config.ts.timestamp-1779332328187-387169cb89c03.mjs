// vite.config.ts
import { defineConfig } from "file:///home/fredrick-mureti/my_projects/accrualflow/node_modules/vite/dist/node/index.js";
import react from "file:///home/fredrick-mureti/my_projects/accrualflow/node_modules/@vitejs/plugin-react-swc/index.js";
import path from "path";
import { componentTagger } from "file:///home/fredrick-mureti/my_projects/accrualflow/node_modules/lovable-tagger/dist/index.js";
import { VitePWA } from "file:///home/fredrick-mureti/my_projects/accrualflow/node_modules/vite-plugin-pwa/dist/index.js";
import { tanstackRouter } from "file:///home/fredrick-mureti/my_projects/accrualflow/node_modules/@tanstack/router-plugin/dist/esm/vite.js";
var __vite_injected_original_dirname = "/home/fredrick-mureti/my_projects/accrualflow";
var vite_config_default = defineConfig(({ mode }) => ({
  // Electron loads index.html via file:// — relative base is required.
  // The packaging driver sets ELECTRON_BUILD=1 before invoking `vite build`.
  base: process.env.ELECTRON_BUILD ? "./" : "/",
  server: {
    host: "::",
    port: 8080
  },
  plugins: [
    // Generates src/routeTree.gen.ts from files in src/routes/. Required by
    // the Lovable sandbox dev shell which serves the app via TanStack Start.
    // The actual ERP UI is rendered by react-router-dom inside <App />.
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts"
    }),
    react(),
    mode === "development" ? componentTagger() : null,
    // Service worker is disabled for Electron packaged builds — `file://`
    // is not a secure context for SW registration and adds runtime errors
    // with no benefit. Desktop offline lives in pos.offline.* (preload).
    process.env.ELECTRON_BUILD ? VitePWA({ disable: true }) : VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png", "pwa-192x192.png", "pwa-512x512.png"],
      manifest: {
        name: "AccrualFlow - Business Management Platform",
        short_name: "AccrualFlow",
        description: "Professional invoicing, expense tracking, and financial management for modern businesses",
        theme_color: "#3b82f6",
        background_color: "#000000",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/home",
        categories: ["business", "finance", "productivity"],
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ],
        shortcuts: [
          {
            name: "Finance & Accounting",
            short_name: "Finance",
            description: "Manage accounts, invoices, and financial reports",
            url: "/finance/accounts",
            icons: [{ src: "/icons/finance-96.svg", sizes: "96x96", type: "image/svg+xml" }]
          },
          {
            name: "Point of Sale",
            short_name: "POS",
            description: "Process sales and manage transactions",
            url: "/pos",
            icons: [{ src: "/icons/pos-96.svg", sizes: "96x96", type: "image/svg+xml" }]
          },
          {
            name: "Sales & CRM",
            short_name: "Sales",
            description: "Manage customers and sales orders",
            url: "/sales/orders",
            icons: [{ src: "/icons/sales-96.svg", sizes: "96x96", type: "image/svg+xml" }]
          },
          {
            name: "Inventory",
            short_name: "Inventory",
            description: "Track products and stock levels",
            url: "/inventory/products",
            icons: [{ src: "/icons/inventory-96.svg", sizes: "96x96", type: "image/svg+xml" }]
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // 5 MiB limit
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-cache",
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24
                // 24 hours
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      },
      devOptions: {
        enabled: false
        // Disable in dev to avoid conflicts
      }
    })
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__vite_injected_original_dirname, "./src")
    }
  }
}));
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvaG9tZS9mcmVkcmljay1tdXJldGkvbXlfcHJvamVjdHMvYWNjcnVhbGZsb3dcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9ob21lL2ZyZWRyaWNrLW11cmV0aS9teV9wcm9qZWN0cy9hY2NydWFsZmxvdy92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vaG9tZS9mcmVkcmljay1tdXJldGkvbXlfcHJvamVjdHMvYWNjcnVhbGZsb3cvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcsIHR5cGUgUGx1Z2luT3B0aW9uIH0gZnJvbSBcInZpdGVcIjtcbmltcG9ydCByZWFjdCBmcm9tIFwiQHZpdGVqcy9wbHVnaW4tcmVhY3Qtc3djXCI7XG5pbXBvcnQgcGF0aCBmcm9tIFwicGF0aFwiO1xuaW1wb3J0IHsgY29tcG9uZW50VGFnZ2VyIH0gZnJvbSBcImxvdmFibGUtdGFnZ2VyXCI7XG5pbXBvcnQgeyBWaXRlUFdBIH0gZnJvbSBcInZpdGUtcGx1Z2luLXB3YVwiO1xuaW1wb3J0IHsgdGFuc3RhY2tSb3V0ZXIgfSBmcm9tIFwiQHRhbnN0YWNrL3JvdXRlci1wbHVnaW4vdml0ZVwiO1xuXG4vLyBodHRwczovL3ZpdGVqcy5kZXYvY29uZmlnL1xuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKCh7IG1vZGUgfSkgPT4gKHtcbiAgLy8gRWxlY3Ryb24gbG9hZHMgaW5kZXguaHRtbCB2aWEgZmlsZTovLyBcdTIwMTQgcmVsYXRpdmUgYmFzZSBpcyByZXF1aXJlZC5cbiAgLy8gVGhlIHBhY2thZ2luZyBkcml2ZXIgc2V0cyBFTEVDVFJPTl9CVUlMRD0xIGJlZm9yZSBpbnZva2luZyBgdml0ZSBidWlsZGAuXG4gIGJhc2U6IHByb2Nlc3MuZW52LkVMRUNUUk9OX0JVSUxEID8gJy4vJyA6ICcvJyxcbiAgc2VydmVyOiB7XG4gICAgaG9zdDogXCI6OlwiLFxuICAgIHBvcnQ6IDgwODAsXG4gIH0sXG4gIHBsdWdpbnM6IFtcbiAgICAvLyBHZW5lcmF0ZXMgc3JjL3JvdXRlVHJlZS5nZW4udHMgZnJvbSBmaWxlcyBpbiBzcmMvcm91dGVzLy4gUmVxdWlyZWQgYnlcbiAgICAvLyB0aGUgTG92YWJsZSBzYW5kYm94IGRldiBzaGVsbCB3aGljaCBzZXJ2ZXMgdGhlIGFwcCB2aWEgVGFuU3RhY2sgU3RhcnQuXG4gICAgLy8gVGhlIGFjdHVhbCBFUlAgVUkgaXMgcmVuZGVyZWQgYnkgcmVhY3Qtcm91dGVyLWRvbSBpbnNpZGUgPEFwcCAvPi5cbiAgICB0YW5zdGFja1JvdXRlcih7XG4gICAgICB0YXJnZXQ6IFwicmVhY3RcIixcbiAgICAgIGF1dG9Db2RlU3BsaXR0aW5nOiB0cnVlLFxuICAgICAgcm91dGVzRGlyZWN0b3J5OiBcIi4vc3JjL3JvdXRlc1wiLFxuICAgICAgZ2VuZXJhdGVkUm91dGVUcmVlOiBcIi4vc3JjL3JvdXRlVHJlZS5nZW4udHNcIixcbiAgICB9KSBhcyB1bmtub3duIGFzIFBsdWdpbk9wdGlvbixcbiAgICByZWFjdCgpLFxuICAgIG1vZGUgPT09IFwiZGV2ZWxvcG1lbnRcIiA/IChjb21wb25lbnRUYWdnZXIoKSBhcyB1bmtub3duIGFzIFBsdWdpbk9wdGlvbikgOiBudWxsLFxuICAgIC8vIFNlcnZpY2Ugd29ya2VyIGlzIGRpc2FibGVkIGZvciBFbGVjdHJvbiBwYWNrYWdlZCBidWlsZHMgXHUyMDE0IGBmaWxlOi8vYFxuICAgIC8vIGlzIG5vdCBhIHNlY3VyZSBjb250ZXh0IGZvciBTVyByZWdpc3RyYXRpb24gYW5kIGFkZHMgcnVudGltZSBlcnJvcnNcbiAgICAvLyB3aXRoIG5vIGJlbmVmaXQuIERlc2t0b3Agb2ZmbGluZSBsaXZlcyBpbiBwb3Mub2ZmbGluZS4qIChwcmVsb2FkKS5cbiAgICBwcm9jZXNzLmVudi5FTEVDVFJPTl9CVUlMRCA/IFZpdGVQV0EoeyBkaXNhYmxlOiB0cnVlIH0pIDogVml0ZVBXQSh7XG4gICAgICByZWdpc3RlclR5cGU6ICdhdXRvVXBkYXRlJyxcbiAgICAgIGluY2x1ZGVBc3NldHM6IFsnZmF2aWNvbi5zdmcnLCAnYXBwbGUtdG91Y2gtaWNvbi5wbmcnLCAncHdhLTE5MngxOTIucG5nJywgJ3B3YS01MTJ4NTEyLnBuZyddLFxuICAgICAgbWFuaWZlc3Q6IHtcbiAgICAgICAgbmFtZTogJ0FjY3J1YWxGbG93IC0gQnVzaW5lc3MgTWFuYWdlbWVudCBQbGF0Zm9ybScsXG4gICAgICAgIHNob3J0X25hbWU6ICdBY2NydWFsRmxvdycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnUHJvZmVzc2lvbmFsIGludm9pY2luZywgZXhwZW5zZSB0cmFja2luZywgYW5kIGZpbmFuY2lhbCBtYW5hZ2VtZW50IGZvciBtb2Rlcm4gYnVzaW5lc3NlcycsXG4gICAgICAgIHRoZW1lX2NvbG9yOiAnIzNiODJmNicsXG4gICAgICAgIGJhY2tncm91bmRfY29sb3I6ICcjMDAwMDAwJyxcbiAgICAgICAgZGlzcGxheTogJ3N0YW5kYWxvbmUnLFxuICAgICAgICBvcmllbnRhdGlvbjogJ3BvcnRyYWl0JyxcbiAgICAgICAgc2NvcGU6ICcvJyxcbiAgICAgICAgc3RhcnRfdXJsOiAnL2hvbWUnLFxuICAgICAgICBjYXRlZ29yaWVzOiBbJ2J1c2luZXNzJywgJ2ZpbmFuY2UnLCAncHJvZHVjdGl2aXR5J10sXG4gICAgICAgIGljb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgc3JjOiAnL3B3YS0xOTJ4MTkyLnBuZycsXG4gICAgICAgICAgICBzaXplczogJzE5MngxOTInLFxuICAgICAgICAgICAgdHlwZTogJ2ltYWdlL3BuZycsXG4gICAgICAgICAgICBwdXJwb3NlOiAnYW55J1xuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgc3JjOiAnL3B3YS01MTJ4NTEyLnBuZycsXG4gICAgICAgICAgICBzaXplczogJzUxMng1MTInLFxuICAgICAgICAgICAgdHlwZTogJ2ltYWdlL3BuZycsXG4gICAgICAgICAgICBwdXJwb3NlOiAnYW55J1xuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgc3JjOiAnL3B3YS01MTJ4NTEyLnBuZycsXG4gICAgICAgICAgICBzaXplczogJzUxMng1MTInLFxuICAgICAgICAgICAgdHlwZTogJ2ltYWdlL3BuZycsXG4gICAgICAgICAgICBwdXJwb3NlOiAnbWFza2FibGUnXG4gICAgICAgICAgfVxuICAgICAgICBdLFxuICAgICAgICBzaG9ydGN1dHM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBuYW1lOiAnRmluYW5jZSAmIEFjY291bnRpbmcnLFxuICAgICAgICAgICAgc2hvcnRfbmFtZTogJ0ZpbmFuY2UnLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246ICdNYW5hZ2UgYWNjb3VudHMsIGludm9pY2VzLCBhbmQgZmluYW5jaWFsIHJlcG9ydHMnLFxuICAgICAgICAgICAgdXJsOiAnL2ZpbmFuY2UvYWNjb3VudHMnLFxuICAgICAgICAgICAgaWNvbnM6IFt7IHNyYzogJy9pY29ucy9maW5hbmNlLTk2LnN2ZycsIHNpemVzOiAnOTZ4OTYnLCB0eXBlOiAnaW1hZ2Uvc3ZnK3htbCcgfV1cbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIG5hbWU6ICdQb2ludCBvZiBTYWxlJyxcbiAgICAgICAgICAgIHNob3J0X25hbWU6ICdQT1MnLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246ICdQcm9jZXNzIHNhbGVzIGFuZCBtYW5hZ2UgdHJhbnNhY3Rpb25zJyxcbiAgICAgICAgICAgIHVybDogJy9wb3MnLFxuICAgICAgICAgICAgaWNvbnM6IFt7IHNyYzogJy9pY29ucy9wb3MtOTYuc3ZnJywgc2l6ZXM6ICc5Nng5NicsIHR5cGU6ICdpbWFnZS9zdmcreG1sJyB9XVxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgbmFtZTogJ1NhbGVzICYgQ1JNJyxcbiAgICAgICAgICAgIHNob3J0X25hbWU6ICdTYWxlcycsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogJ01hbmFnZSBjdXN0b21lcnMgYW5kIHNhbGVzIG9yZGVycycsXG4gICAgICAgICAgICB1cmw6ICcvc2FsZXMvb3JkZXJzJyxcbiAgICAgICAgICAgIGljb25zOiBbeyBzcmM6ICcvaWNvbnMvc2FsZXMtOTYuc3ZnJywgc2l6ZXM6ICc5Nng5NicsIHR5cGU6ICdpbWFnZS9zdmcreG1sJyB9XVxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgbmFtZTogJ0ludmVudG9yeScsXG4gICAgICAgICAgICBzaG9ydF9uYW1lOiAnSW52ZW50b3J5JyxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnVHJhY2sgcHJvZHVjdHMgYW5kIHN0b2NrIGxldmVscycsXG4gICAgICAgICAgICB1cmw6ICcvaW52ZW50b3J5L3Byb2R1Y3RzJyxcbiAgICAgICAgICAgIGljb25zOiBbeyBzcmM6ICcvaWNvbnMvaW52ZW50b3J5LTk2LnN2ZycsIHNpemVzOiAnOTZ4OTYnLCB0eXBlOiAnaW1hZ2Uvc3ZnK3htbCcgfV1cbiAgICAgICAgICB9XG4gICAgICAgIF1cbiAgICAgIH0sXG4gICAgICB3b3JrYm94OiB7XG4gICAgICAgIGdsb2JQYXR0ZXJuczogWycqKi8qLntqcyxjc3MsaHRtbCxpY28scG5nLHN2Zyx3b2ZmMn0nXSxcbiAgICAgICAgbWF4aW11bUZpbGVTaXplVG9DYWNoZUluQnl0ZXM6IDUgKiAxMDI0ICogMTAyNCwgLy8gNSBNaUIgbGltaXRcbiAgICAgICAgcnVudGltZUNhY2hpbmc6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICB1cmxQYXR0ZXJuOiAvXmh0dHBzOlxcL1xcLy4qXFwuc3VwYWJhc2VcXC5jb1xcLy4qL2ksXG4gICAgICAgICAgICBoYW5kbGVyOiAnTmV0d29ya0ZpcnN0JyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgY2FjaGVOYW1lOiAnc3VwYWJhc2UtY2FjaGUnLFxuICAgICAgICAgICAgICBleHBpcmF0aW9uOiB7XG4gICAgICAgICAgICAgICAgbWF4RW50cmllczogNTAsXG4gICAgICAgICAgICAgICAgbWF4QWdlU2Vjb25kczogNjAgKiA2MCAqIDI0IC8vIDI0IGhvdXJzXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGNhY2hlYWJsZVJlc3BvbnNlOiB7XG4gICAgICAgICAgICAgICAgc3RhdHVzZXM6IFswLCAyMDBdXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIF1cbiAgICAgIH0sXG4gICAgICBkZXZPcHRpb25zOiB7XG4gICAgICAgIGVuYWJsZWQ6IGZhbHNlIC8vIERpc2FibGUgaW4gZGV2IHRvIGF2b2lkIGNvbmZsaWN0c1xuICAgICAgfVxuICAgIH0pIGFzIHVua25vd24gYXMgUGx1Z2luT3B0aW9uLFxuICBdLmZpbHRlcihCb29sZWFuKSBhcyBQbHVnaW5PcHRpb25bXSxcbiAgcmVzb2x2ZToge1xuICAgIGFsaWFzOiB7XG4gICAgICBcIkBcIjogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCIuL3NyY1wiKSxcbiAgICB9LFxuICB9LFxufSkpO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUF5VCxTQUFTLG9CQUF1QztBQUN6VyxPQUFPLFdBQVc7QUFDbEIsT0FBTyxVQUFVO0FBQ2pCLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMsZUFBZTtBQUN4QixTQUFTLHNCQUFzQjtBQUwvQixJQUFNLG1DQUFtQztBQVF6QyxJQUFPLHNCQUFRLGFBQWEsQ0FBQyxFQUFFLEtBQUssT0FBTztBQUFBO0FBQUE7QUFBQSxFQUd6QyxNQUFNLFFBQVEsSUFBSSxpQkFBaUIsT0FBTztBQUFBLEVBQzFDLFFBQVE7QUFBQSxJQUNOLE1BQU07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
