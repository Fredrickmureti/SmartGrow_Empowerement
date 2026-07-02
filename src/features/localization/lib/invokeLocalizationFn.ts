/**
 * Single entry-point for invoking any localization-pack edge function from
 * the client. It:
 *   1. Forces a session refresh if the access token is missing or expiring
 *      soon (eliminates the "stale-session 401" failure mode).
 *   2. Decodes the typed error envelope produced by `_shared/localizationAuth.ts`
 *      and rethrows as a structured `LocalizationFnError` so callers can
 *      branch on `code` instead of parsing strings.
 *   3. Logs a console group on failure with the full context so the
 *      reported "401" is never opaque again.
 */
import { supabase } from "@/integrations/supabase/client";

export type LocalizationErrorCode =
  | "AUTH_MISSING_HEADER"
  | "AUTH_INVALID_TOKEN"
  | "AUTH_NOT_PLATFORM_ADMIN"
  | "AUTH_NO_ORG_MEMBERSHIP"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "LINT_FAILED"
  | "INTERNAL"
  | "NO_SESSION";

export class LocalizationFnError extends Error {
  code: LocalizationErrorCode;
  status: number;
  context: Record<string, unknown>;
  constructor(code: LocalizationErrorCode, message: string, status = 500, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "LocalizationFnError";
    this.code = code;
    this.status = status;
    this.context = context;
  }
}

/** Soft threshold: refresh if token expires within 30 seconds. */
const REFRESH_LEEWAY_MS = 30_000;

async function ensureLiveSession() {
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;
  if (!session) {
    throw new LocalizationFnError("NO_SESSION", "You are signed out. Please sign in again.", 401);
  }
  const expiresAtMs = (session.expires_at ?? 0) * 1000;
  if (expiresAtMs && expiresAtMs - Date.now() < REFRESH_LEEWAY_MS) {
    const { error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr) {
      throw new LocalizationFnError(
        "AUTH_INVALID_TOKEN",
        "Session expired and could not be refreshed.",
        401,
        { detail: refreshErr.message },
      );
    }
  }
}

export async function invokeLocalizationFn<T = unknown>(
  fnName: string,
  body: Record<string, unknown>,
): Promise<T> {
  await ensureLiveSession();
  const { data, error } = await (supabase as any).functions.invoke(fnName, { body });
  // supabase-js wraps non-2xx as `error`, but the function still returns a
  // structured body that we want to surface. Read it from error.context when
  // available, otherwise fall back to `data`.
  if (error) {
    let parsed: any = null;
    try {
      const ctx: any = (error as any).context;
      if (ctx?.json) parsed = await ctx.json();
      else if (ctx?.response?.json) parsed = await ctx.response.json();
      else if (typeof ctx === "object") parsed = ctx;
    } catch { /* ignore parse failures */ }
    const code: LocalizationErrorCode = parsed?.code ?? "INTERNAL";
    const message = parsed?.error ?? error.message ?? "Edge function call failed";
    const status = (error as any).context?.status ?? 500;
    /* eslint-disable no-console */
    console.groupCollapsed(`[localization] ${fnName} → ${code} (${status})`);
    console.error("message:", message);
    console.error("body:", body);
    console.error("raw error:", error);
    if (parsed) console.error("response:", parsed);
    console.groupEnd();
    /* eslint-enable no-console */
    throw new LocalizationFnError(code, message, status, parsed ?? {});
  }
  // Some functions return { error, code } in a 200 body (legacy). Honour it.
  if (data && typeof data === "object" && "error" in data && (data as any).error) {
    const code: LocalizationErrorCode = (data as any).code ?? "INTERNAL";
    throw new LocalizationFnError(code, (data as any).error, 200, data as Record<string, unknown>);
  }
  return data as T;
}

/** Human-friendly text for the toast layer. */
export function describeLocalizationError(e: unknown): string {
  if (!(e instanceof LocalizationFnError)) return (e as any)?.message ?? "Unknown error";
  switch (e.code) {
    case "NO_SESSION":
    case "AUTH_MISSING_HEADER":
    case "AUTH_INVALID_TOKEN":
      return "Your session expired. Please sign in again.";
    case "AUTH_NOT_PLATFORM_ADMIN":
      return "Only platform admins can perform this action.";
    case "AUTH_NO_ORG_MEMBERSHIP":
      return "You don't have access to this organization.";
    case "VALIDATION_FAILED":
      return `Validation failed: ${e.message}`;
    case "LINT_FAILED":
      return `Pack lint failed: ${e.message}`;
    case "CONFLICT":
      return e.message;
    case "BAD_REQUEST":
      return e.message;
    case "NOT_FOUND":
      return e.message;
    default:
      return e.message || "Unexpected error";
  }
}
