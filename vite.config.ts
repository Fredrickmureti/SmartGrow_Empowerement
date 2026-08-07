import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: process.env.ELECTRON_BUILD ? './' : '/',
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    mode === "development" ? (componentTagger() as unknown as PluginOption) : null,
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
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        // Authenticated Supabase requests must always reach PostgREST. Caching
        // them can preserve an obsolete RPC request shape across deployments.
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }) as unknown as PluginOption,
  ].filter(Boolean) as PluginOption[],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
