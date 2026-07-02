/**
 * Shared formatter for install-localization-pack edge responses.
 *
 * The edge function returns a structured body of the shape
 *   { error, code, step?, sqlstate?, pg_message?, pg_detail? }
 * on every classified failure. Callers historically dropped that detail
 * and showed a generic "Failed to install localization pack" toast,
 * hiding the actual cause (PAYROLL_NOT_INSTALLED, INSTALL_DUPLICATE,
 * INSTALL_CHECK_VIOLATION, etc.). This helper produces an accountant-
 * readable { title, description } pair for toast.error.
 *
 * Architecture rule: the literal string "Failed to install localization
 * pack" MUST only appear in this file (enforced by an architecture test).
 * Every caller MUST go through `formatInstallerError`.
 */

const GENERIC_TITLE = "Failed to install localization pack";

type InstallerErrorBody = {
  error?: string;
  code?: string;
  step?: string;
  sqlstate?: string;
  pg_message?: string;
  pg_detail?: string;
  message?: string;
};

export type FormattedInstallerError = {
  title: string;
  description?: string;
};

function pickTitle(code?: string): string {
  switch (code) {
    case "PAYROLL_NOT_INSTALLED":
      return "Install the Payroll app first";
    case "APP_NOT_INSTALLED":
      return "Required app is not installed";
    case "ENTITLEMENT_REQUIRED":
      return "Subscription upgrade required";
    case "INSTALL_DUPLICATE":
      return "Pack already installed";
    case "INSTALL_CHECK_VIOLATION":
      return "Pack integrity check failed";
    case "INSTALL_SCHEMA_DRIFT":
      return "Pack install hit a schema mismatch";
    case "INSTALL_INVALID_DATA":
      return "Pack contains invalid data";
    case "INSTALL_PRECONDITION_FAILED":
      return "Pack install precondition failed";
    case "AUTH_INVALID_TOKEN":
    case "AUTH_MISSING_HEADER":
      return "Your session expired";
    case "NOT_FOUND":
      return "Pack or business not found";
    default:
      return GENERIC_TITLE;
  }
}

export function formatInstallerError(
  body: unknown,
  fallbackMessage?: string,
): FormattedInstallerError {
  // Accept either a parsed body, or an Error/FunctionsHttpError that
  // invokeWithAuth has hydrated with copied-up fields and/or a `.body`.
  let b = (body ?? {}) as InstallerErrorBody & { body?: InstallerErrorBody };
  if (b && typeof b === "object" && b.body && typeof b.body === "object") {
    // Prefer hydrated copied-up fields, fall back to .body for anything missing.
    b = { ...(b.body as InstallerErrorBody), ...b };
  }
  const title = pickTitle(b.code);
  const parts: string[] = [];

  if (b.error || b.message || fallbackMessage) {
    parts.push(String(b.error ?? b.message ?? fallbackMessage));
  }
  const meta: string[] = [];
  if (b.step && b.step !== "unknown") meta.push(`step=${b.step}`);
  if (b.sqlstate) meta.push(`sqlstate=${b.sqlstate}`);
  if (meta.length) parts.push(`(${meta.join(", ")})`);
  if (b.pg_message && b.pg_message !== b.error) parts.push(b.pg_message);

  return {
    title,
    description: parts.length ? parts.join(" ") : undefined,
  };
}

/**
 * True when an installer error indicates the pack is already installed
 * (idempotent re-click or unique-constraint hit). Callers should treat
 * this as an info state and refetch installed-pack state, not as a failure.
 */
export function isAlreadyInstalledError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const top = err as { code?: string; body?: { code?: string } };
  return top.code === "INSTALL_DUPLICATE" || top.body?.code === "INSTALL_DUPLICATE";
}

/**
 * Convenience wrapper for sonner-style `toast.error(title, { description })`.
 * Returns the tuple so callers can spread it directly:
 *   toast.error(...toastInstallerError(err))
 */
export function toastInstallerError(
  body: unknown,
  fallbackMessage?: string,
): [string, { description?: string }] {
  const { title, description } = formatInstallerError(body, fallbackMessage);
  return [title, { description }];
}
