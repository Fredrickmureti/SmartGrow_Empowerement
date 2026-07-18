/**
 * Playwright configuration — WMS end-to-end harness (Phase 14).
 *
 * Two projects:
 *  - `wms`  → desktop shell flows under `e2e/wms/`
 *  - `wm`   → mobile RF shell flows under `e2e/wm/` (offline-queue drain)
 *
 * The dev server is assumed to be already running on http://localhost:8080
 * (Vite). We don't spawn it from here — the sandbox and local dev both
 * keep it live already, and starting it twice fights for the port.
 *
 * Auth: specs restore a managed Supabase session via env vars
 * (`LOVABLE_BROWSER_SUPABASE_*`) using the pattern documented in
 * `docs/wms/e2e-harness.md`. Do NOT hard-code credentials here.
 */
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.WMS_E2E_BASE_URL ?? "http://localhost:8080";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // WMS state is shared across specs; keep serial for now.
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    {
      name: "wms",
      testDir: "./e2e/wms",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "wm",
      testDir: "./e2e/wm",
      use: {
        ...devices["Pixel 7"],
      },
    },
  ],
});
