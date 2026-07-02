// vite.config.ts
import { defineConfig } from "file:///home/fredrick-mureti/my_projects/accrualflow/node_modules/vite/dist/node/index.js";
import react from "file:///home/fredrick-mureti/my_projects/accrualflow/node_modules/@vitejs/plugin-react-swc/index.js";
import path from "path";
import { componentTagger } from "file:///home/fredrick-mureti/my_projects/accrualflow/node_modules/lovable-tagger/dist/index.js";
import { VitePWA } from "file:///home/fredrick-mureti/my_projects/accrualflow/node_modules/vite-plugin-pwa/dist/index.js";
import { tanstackRouter } from "file:///home/fredrick-mureti/my_projects/accrualflow/node_modules/@tanstack/router-plugin/dist/esm/vite.js";
var __vite_injected_original_dirname = "/home/fredrick-mureti/my_projects/accrualflow";
var vite_config_default = defineConfig(({ mode }) => ({
  base: "/",
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
    mode === "development" && componentTagger(),
    VitePWA({
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvaG9tZS9mcmVkcmljay1tdXJldGkvbXlfcHJvamVjdHMvYWNjcnVhbGZsb3dcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9ob21lL2ZyZWRyaWNrLW11cmV0aS9teV9wcm9qZWN0cy9hY2NydWFsZmxvdy92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vaG9tZS9mcmVkcmljay1tdXJldGkvbXlfcHJvamVjdHMvYWNjcnVhbGZsb3cvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IHJlYWN0IGZyb20gXCJAdml0ZWpzL3BsdWdpbi1yZWFjdC1zd2NcIjtcbmltcG9ydCBwYXRoIGZyb20gXCJwYXRoXCI7XG5pbXBvcnQgeyBjb21wb25lbnRUYWdnZXIgfSBmcm9tIFwibG92YWJsZS10YWdnZXJcIjtcbmltcG9ydCB7IFZpdGVQV0EgfSBmcm9tIFwidml0ZS1wbHVnaW4tcHdhXCI7XG5pbXBvcnQgeyB0YW5zdGFja1JvdXRlciB9IGZyb20gXCJAdGFuc3RhY2svcm91dGVyLXBsdWdpbi92aXRlXCI7XG5cbi8vIGh0dHBzOi8vdml0ZWpzLmRldi9jb25maWcvXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoKHsgbW9kZSB9KSA9PiAoe1xuICBiYXNlOiAnLycsXG4gIHNlcnZlcjoge1xuICAgIGhvc3Q6IFwiOjpcIixcbiAgICBwb3J0OiA4MDgwLFxuICB9LFxuICBwbHVnaW5zOiBbXG4gICAgLy8gR2VuZXJhdGVzIHNyYy9yb3V0ZVRyZWUuZ2VuLnRzIGZyb20gZmlsZXMgaW4gc3JjL3JvdXRlcy8uIFJlcXVpcmVkIGJ5XG4gICAgLy8gdGhlIExvdmFibGUgc2FuZGJveCBkZXYgc2hlbGwgd2hpY2ggc2VydmVzIHRoZSBhcHAgdmlhIFRhblN0YWNrIFN0YXJ0LlxuICAgIC8vIFRoZSBhY3R1YWwgRVJQIFVJIGlzIHJlbmRlcmVkIGJ5IHJlYWN0LXJvdXRlci1kb20gaW5zaWRlIDxBcHAgLz4uXG4gICAgdGFuc3RhY2tSb3V0ZXIoe1xuICAgICAgdGFyZ2V0OiBcInJlYWN0XCIsXG4gICAgICBhdXRvQ29kZVNwbGl0dGluZzogdHJ1ZSxcbiAgICAgIHJvdXRlc0RpcmVjdG9yeTogXCIuL3NyYy9yb3V0ZXNcIixcbiAgICAgIGdlbmVyYXRlZFJvdXRlVHJlZTogXCIuL3NyYy9yb3V0ZVRyZWUuZ2VuLnRzXCIsXG4gICAgfSksXG4gICAgcmVhY3QoKSxcbiAgICBtb2RlID09PSBcImRldmVsb3BtZW50XCIgJiYgY29tcG9uZW50VGFnZ2VyKCksXG4gICAgVml0ZVBXQSh7XG4gICAgICByZWdpc3RlclR5cGU6ICdhdXRvVXBkYXRlJyxcbiAgICAgIGluY2x1ZGVBc3NldHM6IFsnZmF2aWNvbi5zdmcnLCAnYXBwbGUtdG91Y2gtaWNvbi5wbmcnLCAncHdhLTE5MngxOTIucG5nJywgJ3B3YS01MTJ4NTEyLnBuZyddLFxuICAgICAgbWFuaWZlc3Q6IHtcbiAgICAgICAgbmFtZTogJ0FjY3J1YWxGbG93IC0gQnVzaW5lc3MgTWFuYWdlbWVudCBQbGF0Zm9ybScsXG4gICAgICAgIHNob3J0X25hbWU6ICdBY2NydWFsRmxvdycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnUHJvZmVzc2lvbmFsIGludm9pY2luZywgZXhwZW5zZSB0cmFja2luZywgYW5kIGZpbmFuY2lhbCBtYW5hZ2VtZW50IGZvciBtb2Rlcm4gYnVzaW5lc3NlcycsXG4gICAgICAgIHRoZW1lX2NvbG9yOiAnIzNiODJmNicsXG4gICAgICAgIGJhY2tncm91bmRfY29sb3I6ICcjMDAwMDAwJyxcbiAgICAgICAgZGlzcGxheTogJ3N0YW5kYWxvbmUnLFxuICAgICAgICBvcmllbnRhdGlvbjogJ3BvcnRyYWl0JyxcbiAgICAgICAgc2NvcGU6ICcvJyxcbiAgICAgICAgc3RhcnRfdXJsOiAnL2hvbWUnLFxuICAgICAgICBjYXRlZ29yaWVzOiBbJ2J1c2luZXNzJywgJ2ZpbmFuY2UnLCAncHJvZHVjdGl2aXR5J10sXG4gICAgICAgIGljb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgc3JjOiAnL3B3YS0xOTJ4MTkyLnBuZycsXG4gICAgICAgICAgICBzaXplczogJzE5MngxOTInLFxuICAgICAgICAgICAgdHlwZTogJ2ltYWdlL3BuZycsXG4gICAgICAgICAgICBwdXJwb3NlOiAnYW55J1xuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgc3JjOiAnL3B3YS01MTJ4NTEyLnBuZycsXG4gICAgICAgICAgICBzaXplczogJzUxMng1MTInLFxuICAgICAgICAgICAgdHlwZTogJ2ltYWdlL3BuZycsXG4gICAgICAgICAgICBwdXJwb3NlOiAnYW55J1xuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgc3JjOiAnL3B3YS01MTJ4NTEyLnBuZycsXG4gICAgICAgICAgICBzaXplczogJzUxMng1MTInLFxuICAgICAgICAgICAgdHlwZTogJ2ltYWdlL3BuZycsXG4gICAgICAgICAgICBwdXJwb3NlOiAnbWFza2FibGUnXG4gICAgICAgICAgfVxuICAgICAgICBdLFxuICAgICAgICBzaG9ydGN1dHM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBuYW1lOiAnRmluYW5jZSAmIEFjY291bnRpbmcnLFxuICAgICAgICAgICAgc2hvcnRfbmFtZTogJ0ZpbmFuY2UnLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246ICdNYW5hZ2UgYWNjb3VudHMsIGludm9pY2VzLCBhbmQgZmluYW5jaWFsIHJlcG9ydHMnLFxuICAgICAgICAgICAgdXJsOiAnL2ZpbmFuY2UvYWNjb3VudHMnLFxuICAgICAgICAgICAgaWNvbnM6IFt7IHNyYzogJy9pY29ucy9maW5hbmNlLTk2LnN2ZycsIHNpemVzOiAnOTZ4OTYnLCB0eXBlOiAnaW1hZ2Uvc3ZnK3htbCcgfV1cbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIG5hbWU6ICdQb2ludCBvZiBTYWxlJyxcbiAgICAgICAgICAgIHNob3J0X25hbWU6ICdQT1MnLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246ICdQcm9jZXNzIHNhbGVzIGFuZCBtYW5hZ2UgdHJhbnNhY3Rpb25zJyxcbiAgICAgICAgICAgIHVybDogJy9wb3MnLFxuICAgICAgICAgICAgaWNvbnM6IFt7IHNyYzogJy9pY29ucy9wb3MtOTYuc3ZnJywgc2l6ZXM6ICc5Nng5NicsIHR5cGU6ICdpbWFnZS9zdmcreG1sJyB9XVxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgbmFtZTogJ1NhbGVzICYgQ1JNJyxcbiAgICAgICAgICAgIHNob3J0X25hbWU6ICdTYWxlcycsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogJ01hbmFnZSBjdXN0b21lcnMgYW5kIHNhbGVzIG9yZGVycycsXG4gICAgICAgICAgICB1cmw6ICcvc2FsZXMvb3JkZXJzJyxcbiAgICAgICAgICAgIGljb25zOiBbeyBzcmM6ICcvaWNvbnMvc2FsZXMtOTYuc3ZnJywgc2l6ZXM6ICc5Nng5NicsIHR5cGU6ICdpbWFnZS9zdmcreG1sJyB9XVxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgbmFtZTogJ0ludmVudG9yeScsXG4gICAgICAgICAgICBzaG9ydF9uYW1lOiAnSW52ZW50b3J5JyxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnVHJhY2sgcHJvZHVjdHMgYW5kIHN0b2NrIGxldmVscycsXG4gICAgICAgICAgICB1cmw6ICcvaW52ZW50b3J5L3Byb2R1Y3RzJyxcbiAgICAgICAgICAgIGljb25zOiBbeyBzcmM6ICcvaWNvbnMvaW52ZW50b3J5LTk2LnN2ZycsIHNpemVzOiAnOTZ4OTYnLCB0eXBlOiAnaW1hZ2Uvc3ZnK3htbCcgfV1cbiAgICAgICAgICB9XG4gICAgICAgIF1cbiAgICAgIH0sXG4gICAgICB3b3JrYm94OiB7XG4gICAgICAgIGdsb2JQYXR0ZXJuczogWycqKi8qLntqcyxjc3MsaHRtbCxpY28scG5nLHN2Zyx3b2ZmMn0nXSxcbiAgICAgICAgbWF4aW11bUZpbGVTaXplVG9DYWNoZUluQnl0ZXM6IDUgKiAxMDI0ICogMTAyNCwgLy8gNSBNaUIgbGltaXRcbiAgICAgICAgcnVudGltZUNhY2hpbmc6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICB1cmxQYXR0ZXJuOiAvXmh0dHBzOlxcL1xcLy4qXFwuc3VwYWJhc2VcXC5jb1xcLy4qL2ksXG4gICAgICAgICAgICBoYW5kbGVyOiAnTmV0d29ya0ZpcnN0JyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgY2FjaGVOYW1lOiAnc3VwYWJhc2UtY2FjaGUnLFxuICAgICAgICAgICAgICBleHBpcmF0aW9uOiB7XG4gICAgICAgICAgICAgICAgbWF4RW50cmllczogNTAsXG4gICAgICAgICAgICAgICAgbWF4QWdlU2Vjb25kczogNjAgKiA2MCAqIDI0IC8vIDI0IGhvdXJzXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGNhY2hlYWJsZVJlc3BvbnNlOiB7XG4gICAgICAgICAgICAgICAgc3RhdHVzZXM6IFswLCAyMDBdXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIF1cbiAgICAgIH0sXG4gICAgICBkZXZPcHRpb25zOiB7XG4gICAgICAgIGVuYWJsZWQ6IGZhbHNlIC8vIERpc2FibGUgaW4gZGV2IHRvIGF2b2lkIGNvbmZsaWN0c1xuICAgICAgfVxuICAgIH0pXG4gIF0uZmlsdGVyKEJvb2xlYW4pLFxuICByZXNvbHZlOiB7XG4gICAgYWxpYXM6IHtcbiAgICAgIFwiQFwiOiBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcIi4v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
