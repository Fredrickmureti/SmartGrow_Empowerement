/**
 * invokeWithAuth — single deterministic entry point for calling Supabase
 * edge functions that require an authenticated caller.
 *
 * Why this exists:
 *   `supabase.functions.invoke` silently falls back to the anon key when no
 *   user session is hydrated yet (e.g. right after signup, after a tenant
 *   reset, or before AuthContext finishes restoring localStorage). The edge
 *   function then receives an anon JWT, fails its `auth.getUser()` check,
 *   and returns 401 — surfaced to users as a generic "Failed to install".
 *
 * This helper:
 *   1. Reads the current session and refreshes it if the access token is
 *      within `REFRESH_WINDOW_SECONDS` of expiry.
 *   2. Throws a typed `NotAuthenticatedError` if no valid session exists
 *      — callers can map this to a "sign in again" UX instead of a generic
 *      failure toast.
 *   3. Attaches the user JWT explicitly via the `Authorization` header so
 *      we never rely on supabase-js internals choosing anon vs. user token.
 */
import { supabase } from "./client";
import type { FunctionInvokeOptions } from "@supabase/functions-js";

const REFRESH_WINDOW_SECONDS = 30;

export class NotAuthenticatedError extends Error {
  readonly code = "NOT_AUTHENTICATED";
  constructor(message = "No active session. Please sign in again.") {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

interface InvokeWithAuthOptions<TBody> extends Omit<FunctionInvokeOptions, "body" | "headers"> {
  body?: TBody;
  headers?: Record<string, string>;
}

export async function invokeWithAuth<TResponse = unknown, TBody = unknown>(
  functionName: string,
  options: InvokeWithAuthOptions<TBody> = {},
): Promise<{ data: TResponse | null; error: Error | null }> {
  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
  if (sessionErr) {
    throw new NotAuthenticatedError(`Failed to read session: ${sessionErr.message}`);
  }

  let session = sessionData.session;
  if (!session?.access_token) {
    throw new NotAuthenticatedError();
  }

  // Refresh proactively if the token is near expiry. This protects the
  // "page kept open after the previous tenant was deleted" case.
  const expiresAt = session.expires_at ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (expiresAt && expiresAt - nowSec < REFRESH_WINDOW_SECONDS) {
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr || !refreshed.session?.access_token) {
      throw new NotAuthenticatedError(
        `Session expired and could not be refreshed${
          refreshErr ? `: ${refreshErr.message}` : ""
        }.`,
      );
    }
    session = refreshed.session;
  }

  const { body, headers: extraHeaders, ...rest } = options;
  const result = await supabase.functions.invoke<TResponse>(functionName, {
    ...rest,
    body: body as never,
    headers: {
      ...(extraHeaders ?? {}),
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  // supabase-js wraps non-2xx responses in a FunctionsHttpError whose body
  // is buried in `.context` (an unread Response). Without parsing it,
  // structured edge-fn payloads like
  //   { error, code: "INSTALL_DUPLICATE", step, sqlstate, ... }
  // are invisible to callers and every failure collapses into a generic
  // toast. Read the body once and copy its fields onto the error object so
  // helpers like formatInstallerError can render the real cause.
  if (result.error) {
    await hydrateFunctionsError(result.error as Error & { context?: unknown });
  }
  return result;
}

async function hydrateFunctionsError(
  err: Error & { context?: unknown; body?: unknown; status?: number; code?: string },
): Promise<void> {
  const ctx = err.context as Response | undefined;
  if (!ctx || typeof (ctx as Response).clone !== "function") return;
  try {
    // Clone so consumers that re-read .context still work.
    const cloned = (ctx as Response).clone();
    err.status = (ctx as Response).status;
    const text = await cloned.text();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body: preserve as raw text.
      (err as { rawBody?: string }).rawBody = text;
      return;
    }
    err.body = parsed;
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      const target = err as unknown as Record<string, unknown>;
      for (const key of ["error", "code", "step", "sqlstate", "pg_message", "pg_detail", "message"]) {
        if (p[key] !== undefined && target[key] === undefined) {
          target[key] = p[key];
        }
      }
      // If the server provided a human message, surface it on err.message
      // so default toast paths show something useful too.
      const serverMsg = (p.error ?? p.message) as string | undefined;
      if (typeof serverMsg === "string" && serverMsg.length > 0) {
        err.message = serverMsg;
      }
    }
  } catch {
    // Reading the body is best-effort; never let it mask the original error.
  }
}
