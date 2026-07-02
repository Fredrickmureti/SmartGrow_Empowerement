/**
 * lazyWithRetry - React.lazy() wrapper that handles stale chunk errors
 * 
 * After a new deployment, Vite's hashed filenames change. Users with cached
 * HTML will try to load chunks that no longer exist. This wrapper:
 * 1. Catches the import failure
 * 2. Reloads the page once to fetch the new asset manifest
 * 3. Uses sessionStorage to prevent infinite reload loops
 * 4. On second failure, throws so the error boundary can handle it gracefully
 */

import { lazy, ComponentType } from "react";

function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("failed to fetch dynamically imported module") ||
    msg.includes("loading chunk") ||
    msg.includes("loading css chunk") ||
    msg.includes("dynamically imported module")
  );
}

export function lazyWithRetry<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>
) {
  return lazy(() =>
    importFn().catch((error: unknown) => {
      if (!isChunkLoadError(error)) {
        throw error;
      }

      // Build a stable key from the import function string
      const key = `chunk-retry-${btoa(importFn.toString()).slice(0, 20)}`;

      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        // Reload to get the new HTML with updated chunk references
        window.location.reload();
        // Return a never-resolving promise to prevent React from rendering
        // while the page reloads
        return new Promise<{ default: T }>(() => {});
      }

      // Already retried once — clear the flag and let the error boundary handle it
      sessionStorage.removeItem(key);
      throw error;
    })
  );
}
