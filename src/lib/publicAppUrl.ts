/**
 * publicAppUrl — single source of truth for the externally-reachable URL
 * the app is served from.
 *
 * Used when handing a URL to a device that is NOT the machine running the
 * app (phones scanning a pairing QR, email/SMS links, webhooks pointing
 * back at us). NEVER use `window.location.origin` for those cases — on
 * localhost, preview deployments, or Electron `file://` builds it is
 * unreachable from any other device.
 *
 * Resolution order (first match wins):
 *   1. `window.__POS_PUBLIC_APP_URL__` — runtime override injected by
 *      Electron preload or test harnesses.
 *   2. `localStorage["pos.public_app_url"]` — per-install operator override.
 *   3. `import.meta.env.VITE_PUBLIC_APP_URL` — build-time override.
 *   4. `PRODUCTION_APP_URL` — the canonical production host. This is the
 *      default for every developer machine, preview deployment, and
 *      Electron build so QR codes always resolve to a publicly reachable
 *      origin regardless of where the desk happens to run.
 *
 * `window.location.origin` is intentionally NOT used as a fallback. A
 * phone scanning a QR pointing at `http://localhost:8080` or
 * `https://id-preview--xxxx.lovable.app` will either time out (different
 * device) or land on a deployment the operator is not signed into. The
 * production URL is the only host that is always reachable.
 */

export const PRODUCTION_APP_URL = "https://www.accrualflow.systems";

export class PublicAppUrlUnavailableError extends Error {
  constructor(message = "Public app URL is not configured") {
    super(message);
    this.name = "PublicAppUrlUnavailableError";
  }
}

const NETWORK_PROTOCOLS = new Set(["http:", "https:"]);

/** Canonical production host, without the `www.` prefix. */
const PRODUCTION_HOST = "accrualflow.systems";

function normalize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!NETWORK_PROTOCOLS.has(parsed.protocol)) return null;
  // Any spelling of the production host canonicalises to the one origin the
  // certificate and auth cookies are issued for (https + www). A stray
  // `http://accrualflow.systems` in an env file must never end up in a QR.
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === PRODUCTION_HOST) return PRODUCTION_APP_URL;
  return parsed.origin;
}


declare global {
  interface Window {
    __POS_PUBLIC_APP_URL__?: string;
  }
}

const STORAGE_KEY = "pos.public_app_url";

function readLocalOverride(): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Resolve the public app URL. Returns an origin without trailing slash.
 * Always returns a usable URL — falls back to PRODUCTION_APP_URL.
 */
export function getPublicAppUrl(): string {
  // 1. Runtime override (Electron preload / tests)
  const runtime =
    typeof window !== "undefined" ? normalize(window.__POS_PUBLIC_APP_URL__) : null;
  if (runtime) return runtime;

  // 2. Per-install operator override
  const stored = normalize(readLocalOverride());
  if (stored) return stored;

  // 3. Build-time env override.
  // Bracket access on purpose: Vite statically inlines `import.meta.env.FOO`,
  // which makes the value un-overridable at runtime (and in tests).
  const envBag = (typeof import.meta !== "undefined"
    ? ((import.meta as any).env as Record<string, string> | undefined)
    : undefined) as Record<string, string | undefined> | undefined;
  const procBag =
    typeof process !== "undefined"
      ? (process.env as Record<string, string | undefined> | undefined)
      : undefined;
  // process.env first: it is the runtime-mutable bag (Node/SSR and test
  // harnesses), whereas Vite freezes VITE_* values into import.meta.env at
  // build time.
  const envVal = normalize(
    procBag?.["VITE_PUBLIC_APP_URL"] ?? envBag?.["VITE_PUBLIC_APP_URL"] ?? null,
  );

  if (envVal) return envVal;



  // 4. Canonical production host — guaranteed reachable from any phone.
  return PRODUCTION_APP_URL;
}

/** Non-throwing variant. Kept for back-compat with existing call sites. */
export function tryGetPublicAppUrl(): string | null {
  try {
    return getPublicAppUrl();
  } catch {
    return null;
  }
}

/** Operator-facing setter — writes the per-install override. */
export function setPublicAppUrlOverride(value: string | null): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  if (!value) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const normalized = normalize(value);
  if (!normalized) throw new Error("Public app URL must be http(s)://");
  window.localStorage.setItem(STORAGE_KEY, normalized);
}

export const __publicAppUrlInternals = { STORAGE_KEY, normalize };
