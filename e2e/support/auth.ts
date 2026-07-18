/**
 * Shared auth helper for WMS Playwright specs.
 *
 * Restores the managed Supabase session (localStorage + SSR cookies)
 * before any authenticated route is hit. Mirrors the pattern from the
 * repo-level browser-use directive so specs work identically in the
 * sandbox and on a developer laptop that has run `bunx supabase link`.
 *
 * IMPORTANT: uses `page.evaluate` after navigating to the app origin —
 * never `context.addInitScript`, which would leak the access token into
 * every origin the browser touches.
 */
import type { Page, BrowserContext } from "@playwright/test";

const APP_ORIGIN = process.env.WMS_E2E_BASE_URL ?? "http://localhost:8080";

export async function restoreSupabaseSession(
  context: BrowserContext,
  page: Page,
) {
  const storageKey = process.env.LOVABLE_BROWSER_SUPABASE_STORAGE_KEY;
  const sessionJson = process.env.LOVABLE_BROWSER_SUPABASE_SESSION_JSON;
  const cookiesJson = process.env.LOVABLE_BROWSER_SUPABASE_COOKIES_JSON;

  if (cookiesJson) {
    const cookies = JSON.parse(cookiesJson) as Array<Record<string, unknown>>;
    for (const c of cookies) c.url = APP_ORIGIN;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await context.addCookies(cookies as any);
  }

  await page.goto(APP_ORIGIN);
  if (storageKey && sessionJson) {
    await page.evaluate(
      ([k, v]) => window.localStorage.setItem(k, v),
      [storageKey, sessionJson],
    );
  }
}

export function authAvailable(): boolean {
  return (
    process.env.LOVABLE_BROWSER_AUTH_STATUS === "injected" ||
    !!process.env.LOVABLE_BROWSER_SUPABASE_SESSION_JSON
  );
}
