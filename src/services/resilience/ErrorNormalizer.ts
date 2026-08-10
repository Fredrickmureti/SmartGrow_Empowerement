/**
 * ErrorNormalizer
 *
 * Pure mapping from any thrown value (Supabase error, fetch error,
 * generic Error, string) into a closed-set `NormalizedError` so the UI
 * layer never has to render raw `error.message` to users.
 *
 * Add new kinds here, NOT in calling code. UI components import
 * `normalizeError(...)` and render the canonical title/message/action.
 */

export type ErrorKind =
  | "offline"
  | "timeout"
  | "auth_expired"
  | "auth_invalid"
  | "permission_denied"
  | "not_found"
  | "server_unavailable"
  | "conflict"
  | "validation"
  | "unknown";

export interface NormalizedError {
  kind: ErrorKind;
  title: string;
  /** Human-readable, action-oriented message. NEVER contains raw infra text. */
  message: string;
  /** Suggested next user action. */
  action: string;
  retryable: boolean;
  /** Original error preserved for logs only — do NOT render. */
  cause?: unknown;
}

const CATALOG: Record<ErrorKind, Omit<NormalizedError, "kind" | "cause">> = {
  offline: {
    title: "You're offline",
    message:
      "We couldn't reach the server. Check your internet connection and try again.",
    action: "Reconnect and retry",
    retryable: true,
  },
  timeout: {
    title: "Request timed out",
    message: "The request took too long to complete. Please try again.",
    action: "Retry",
    retryable: true,
  },
  auth_expired: {
    title: "Session expired",
    message: "Your session has expired. Please sign in again.",
    action: "Sign in",
    retryable: false,
  },
  auth_invalid: {
    title: "Invalid credentials",
    message: "The email or password you entered is incorrect.",
    action: "Try again",
    retryable: false,
  },
  permission_denied: {
    title: "Not allowed",
    message: "You do not have permission to perform this action.",
    action: "Contact your administrator",
    retryable: false,
  },
  not_found: {
    title: "Not found",
    message: "The item you were looking for could not be found.",
    action: "Refresh and try again",
    retryable: false,
  },
  server_unavailable: {
    title: "Servers temporarily unavailable",
    message:
      "Our servers are temporarily unavailable. Please try again shortly.",
    action: "Retry",
    retryable: true,
  },
  conflict: {
    title: "Update conflict",
    message:
      "Someone else updated this record while you were editing. Refresh to see the latest version.",
    action: "Refresh",
    retryable: false,
  },
  validation: {
    title: "Check your input",
    message: "Some of the information you entered is not valid.",
    action: "Review and resubmit",
    retryable: false,
  },
  unknown: {
    title: "Something went wrong",
    message: "An unexpected error occurred. Please try again.",
    action: "Retry",
    retryable: true,
  },
};

import { authExpiryCoordinator } from "./AuthExpiryCoordinator";

function shape(kind: ErrorKind, cause?: unknown, override?: Partial<NormalizedError>): NormalizedError {
  const result: NormalizedError = { kind, ...CATALOG[kind], cause, ...override };
  // Side-effect: when a normalized error is auth_expired, notify the
  // global coordinator so we get exactly one toast + redirect across
  // every hook that 401s in the same window.
  if (kind === "auth_expired") {
    try { authExpiryCoordinator.trigger(); } catch { /* coordinator failures must not break normalization */ }
  }
  return result;
}

/**
 * Heuristic for "network unreachable" errors. Covers:
 * - `TypeError: Failed to fetch` (Chrome/Edge)
 * - `TypeError: NetworkError when attempting to fetch resource.` (Firefox)
 * - `TypeError: Load failed` (Safari)
 * - `AbortError` from a manual timeout
 */
function isNetworkError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: string; message?: string };
    const msg = (e.message || "").toLowerCase();
    if (e.name === "AbortError") return true;
    if (msg.includes("failed to fetch")) return true;
    if (msg.includes("networkerror")) return true;
    if (msg.includes("network error")) return true;
    if (msg === "load failed") return true;
    if (msg.includes("err_internet_disconnected")) return true;
  }
  return false;
}

function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

/**
 * Map any thrown value to a `NormalizedError`.
 *
 * Pass `connectivity` from `ConnectivityManager.getStatus()` when
 * available so we can distinguish "offline" from "5xx" with confidence.
 */
export function normalizeError(
  err: unknown,
  opts: { connectivity?: "online" | "degraded" | "offline" } = {},
): NormalizedError {
  // Already normalized — pass through.
  if (typeof err === "object" && err !== null && "kind" in err && "title" in err) {
    return err as NormalizedError;
  }

  // 1. Network-level failures.
  if (opts.connectivity === "offline" || !isOnline()) {
    if (isNetworkError(err)) return shape("offline", err);
  }
  if (isNetworkError(err)) {
    // We THINK we're online but the request failed at the transport
    // layer — treat as offline; that's the user's actionable next step.
    return shape("offline", err);
  }

  // 2. Supabase / PostgREST shaped errors.
  if (typeof err === "object" && err !== null) {
    const e = err as {
      status?: number;
      code?: string;
      message?: string;
      name?: string;
    };

    const status = e.status;
    const code = (e.code || "").toString();
    const msg = (e.message || "").toLowerCase();

    if (status === 401 || code === "PGRST301" || msg.includes("jwt expired") || msg.includes("invalid jwt")) {
      return shape("auth_expired", err);
    }
    if (msg.includes("invalid login credentials") || msg.includes("invalid email or password")) {
      return shape("auth_invalid", err);
    }
    if (status === 403 || code === "PGRST302" || msg.includes("permission denied") || msg.includes("not authorized")) {
      return shape("permission_denied", err);
    }
    if (status === 404 || code === "PGRST116") {
      return shape("not_found", err);
    }
    if (status === 409 || code === "23505") {
      return shape("conflict", err);
    }
    // Only user-shaped integrity errors map to "validation". 23502 (NOT NULL)
    // and 23503 (FK violation) are server/integrity bugs — surface them as
    // "unknown" so users don't get a misleading "check your input" toast.
    if (status === 422 || code === "23514" || code === "23P01") {
      return shape("validation", err);
    }
    // Business rules our own RPCs RAISE EXCEPTION with (SQLSTATE P0001) carry
    // an author-written, user-safe sentence ("Allocation exceeds open balance
    // on bill INV-1"). Collapsing those into "An unexpected error occurred"
    // hides the one piece of information the user needs, so pass them through.
    if (code === "P0001" && typeof e.message === "string" && e.message.trim().length > 0) {
      return shape("validation", err, {
        title: "Couldn't complete this action",
        message: e.message.trim(),
        action: "Review and try again",
      });
    }
    // The RPC signature the client called does not exist on the server —
    // a deploy/schema mismatch, not something the user can fix by retrying.
    if (code === "PGRST202") {
      return shape("server_unavailable", err, {
        title: "This action isn't available yet",
        message:
          "The server is running an older version of this feature. Refresh the page, and contact support if it persists.",
        action: "Refresh",
      });
    }
    if (typeof status === "number" && status >= 500) {
      return shape("server_unavailable", err);
    }

    if (msg.includes("timeout") || msg.includes("timed out")) {
      return shape("timeout", err);
    }

  }

  return shape("unknown", err);
}

/**
 * Convenience for components that just need a string. Prefer the full
 * object when you want to drive structure (icon, action button, etc.).
 */
export function describeError(err: unknown): string {
  return normalizeError(err).message;
}