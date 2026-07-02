/**
 * Feature flags — small, deterministic, no infra dependency.
 *
 * Resolution order (highest first):
 *   1. `localStorage["ff:<name>"] === "true" | "false"` — operator override
 *      for browser sessions (handy for QA / staged rollouts).
 *   2. `import.meta.env.VITE_FF_<NAME_UPPER>` === "true" | "false" — set in
 *      `.env` for tenant-wide defaults at build time.
 *   3. Compiled-in default.
 *
 * Adding a flag: declare it in `FLAG_DEFAULTS`, then call `isFeatureEnabled`.
 * Never `if (process.env.X)` outside this file.
 */

const FLAG_DEFAULTS: Record<string, boolean> = {
  // W4b (ADR-0008) — route POS receipts through the unified server engine
  // (`generate-document` → `_shared/escpos/builder.ts`). Default ON.
  // Legacy client renderers have been deleted; this flag is retained for
  // one release as a kill-switch — flipping to false will fail at compile
  // time once imports of `ReceiptTemplateGenerator` / `ReceiptEscPosBuilder`
  // are gone. Remove the flag entirely in the next release cycle.
  pos_unified_renderer: true,
};

export type FeatureFlag = keyof typeof FLAG_DEFAULTS;

export function isFeatureEnabled(name: FeatureFlag): boolean {
  // 1. localStorage override (browser only).
  if (typeof window !== "undefined") {
    try {
      const v = window.localStorage.getItem(`ff:${name}`);
      if (v === "true") return true;
      if (v === "false") return false;
    } catch {
      // localStorage may throw in private mode / SSR — fall through.
    }
  }
  // 2. Vite env override.
  const envKey = `VITE_FF_${name.toUpperCase()}`;
  const envVal = (import.meta as any)?.env?.[envKey];
  if (envVal === "true") return true;
  if (envVal === "false") return false;
  // 3. Compiled-in default.
  return FLAG_DEFAULTS[name] ?? false;
}

/** Convenience helpers — keeps call sites readable. */
export const posUnifiedRenderer = () => isFeatureEnabled("pos_unified_renderer");
