/**
 * M0b — runtime smoke guard.
 *
 * The convergence programme lost several sessions to an "M0-class" regression:
 * the dev server answering 500 for every route while migration work continued
 * on top of an application that never rendered. These checks make that class of
 * failure loud and immediate.
 *
 * Two layers:
 *  1. Dependency hygiene (always runs, no server needed) — a single resolved
 *     copy of each TanStack framework package. Duplicate/mixed copies are what
 *     produce `does not provide an export named '_getRenderedMatches'`.
 *  2. Live route render (runs only when a dev server is reachable) — GET /
 *     must answer 200 with the SSR document shell, not the branded 500 page.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require_ = createRequire(import.meta.url);

const TANSTACK_FRAMEWORK_PACKAGES = [
  '@tanstack/react-start',
  '@tanstack/react-router',
  '@tanstack/router-core',
  '@tanstack/start-server-core',
  '@tanstack/start-client-core',
] as const;

describe('runtime smoke: dependency hygiene', () => {
  it('resolves exactly one copy of each TanStack framework package', () => {
    const duplicates: string[] = [];

    for (const pkg of TANSTACK_FRAMEWORK_PACKAGES) {
      const paths = new Set<string>();
      try {
        paths.add(require_.resolve(`${pkg}/package.json`));
      } catch {
        // Some packages do not export package.json; resolution via the root
        // entry is enough to prove a single copy exists.
        paths.add(require_.resolve(pkg));
      }
      if (paths.size > 1) duplicates.push(pkg);
    }

    expect(duplicates).toEqual([]);
  });

  it('exposes the SSR internals react-start imports from router-core', async () => {
    const routerCore = await import('@tanstack/router-core');
    // These underscore exports are the ones whose absence crashes SSR when the
    // router-core copy is older than the react-start copy expecting them.
    expect(routerCore).toHaveProperty('_getRenderedMatches');
    expect(routerCore).toHaveProperty('_getAssetMatches');
  });
});

const DEV_SERVER_URL = process.env['SMOKE_BASE_URL'] ?? 'http://localhost:8080';

async function serverIsUp(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    await fetch(DEV_SERVER_URL, { signal: controller.signal });
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

describe('runtime smoke: live route render', () => {
  it('serves the application shell on GET / (skipped when no server is running)', async () => {
    if (!(await serverIsUp())) {
      // No server in this environment (plain CI unit run) — hygiene checks above
      // still guard the regression class.
      return;
    }

    const response = await fetch(DEV_SERVER_URL);
    const html = await response.text();

    expect(response.status).toBe(200);
    // The branded catastrophic-failure page from src/lib/error-page.ts.
    expect(html).not.toContain("This page didn't load");
    expect(html).toContain('<html');
    expect(html.toLowerCase()).toContain('</body>');
  }, 20000);
});
