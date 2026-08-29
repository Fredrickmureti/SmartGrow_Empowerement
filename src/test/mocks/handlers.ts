import type { RequestHandler } from 'msw';

/**
 * Default MSW handlers.
 *
 * Intentionally empty: tests register the handlers they need with
 * `server.use(...)`. Unhandled requests surface as errors, which is what we
 * want for architecture and unit tests.
 */
export const handlers: RequestHandler[] = [];
