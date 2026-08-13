/**
 * assistantErrors — the single translator between an `ai-assistant` failure
 * and the sentence a user sees.
 *
 * Why this exists: every transport-level failure used to collapse into
 * `toast.error("Failed to send message")`, which hid the actual boundary that
 * broke (endpoint not deployed, session expired, tenant/entitlement refusal,
 * AI not configured, provider down). Support could not tell those apart, and
 * neither could we.
 *
 * Rules:
 *   - the message returned here is safe to show a user: no stack traces, no
 *     provider payloads, no secrets;
 *   - the diagnostic detail stays on the returned object for `console.error`.
 */

export type AssistantErrorKind =
  | "unreachable"
  | "unauthenticated"
  | "forbidden"
  | "rate_limited"
  | "credits_exhausted"
  | "unconfigured"
  | "server_error"
  | "unknown";

export interface AssistantError {
  kind: AssistantErrorKind;
  /** Safe, user-facing sentence. */
  message: string;
  /** HTTP status when the response reached us at all. */
  status?: number;
  /** Developer detail — log it, never toast it verbatim. */
  detail?: string;
}

/**
 * Map a non-OK edge-function response to a structured error.
 * `body` is the already-parsed JSON payload (or null when unparseable).
 */
export function mapAssistantResponseError(
  status: number,
  body: { error?: string; reason?: string } | null,
): AssistantError {
  const serverMessage = body?.reason || body?.error;

  switch (status) {
    case 401:
      return {
        kind: "unauthenticated",
        status,
        detail: serverMessage,
        message: "Your session has expired. Please sign in again.",
      };
    case 403:
      return {
        kind: "forbidden",
        status,
        detail: serverMessage,
        message:
          serverMessage ||
          "You don't have access to the AI assistant in this workspace.",
      };
    case 404:
      return {
        kind: "unreachable",
        status,
        detail: serverMessage ?? "ai-assistant endpoint not found",
        message:
          "The AI assistant service isn't available right now. Please contact your administrator.",
      };
    case 429:
      return {
        kind: "rate_limited",
        status,
        detail: serverMessage,
        message: "Rate limit exceeded. Please wait a moment and try again.",
      };
    case 402:
      return {
        kind: "credits_exhausted",
        status,
        detail: serverMessage,
        message: "AI credits are exhausted. Please add credits to continue.",
      };
    case 503:
      return {
        kind: "unconfigured",
        status,
        detail: serverMessage,
        message:
          serverMessage ||
          "AI is not configured for this workspace, or the provider is temporarily unavailable.",
      };
    default:
      return {
        kind: status >= 500 ? "server_error" : "unknown",
        status,
        detail: serverMessage,
        message:
          status >= 500
            ? "The AI assistant hit a server error. Please try again."
            : "The AI assistant could not handle that request.",
      };
  }
}

/**
 * Map a thrown error (fetch rejection, stream abort, parse failure) to a
 * structured error. A `TypeError: Failed to fetch` means the request never
 * completed — endpoint down, undeployed, blocked by CORS, or offline.
 */
export function mapAssistantThrownError(error: unknown): AssistantError {
  const detail = error instanceof Error ? error.message : String(error);
  const isTransport =
    error instanceof TypeError ||
    /failed to fetch|networkerror|load failed/i.test(detail);

  if (isTransport) {
    return {
      kind: "unreachable",
      detail,
      message:
        typeof navigator !== "undefined" && navigator.onLine === false
          ? "You appear to be offline. Reconnect and try again."
          : "Couldn't reach the AI assistant service. It may be unavailable — please try again or contact your administrator.",
    };
  }

  return {
    kind: "unknown",
    detail,
    message: "Something went wrong talking to the AI assistant. Please try again.",
  };
}
