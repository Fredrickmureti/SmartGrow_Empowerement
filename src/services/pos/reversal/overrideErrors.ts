/**
 * POS Reversal — override error mapping.
 *
 * `assert_manager_override` raises PostgreSQL exceptions with SQLSTATE
 * `42501` and a machine-tag message like `override_required`,
 * `override_expired`, `override_not_approved (status=...)`, etc. This
 * module translates those raw strings into a stable, user-facing copy
 * catalogue so the terminal can replace the blanket "Override denied /
 * An unexpected error occurred" toast with a specific, actionable
 * message.
 *
 * Stage 3 of the POS refund/reversal remediation (see `.lovable/plan.md`).
 */

export type OverrideErrorCode =
  | "override_required"
  | "override_not_found"
  | "override_not_approved"
  | "override_already_consumed"
  | "override_expired"
  | "override_org_mismatch"
  | "override_business_mismatch"
  | "override_action_mismatch"
  | "override_shift_mismatch"
  | "override_role_not_allowed"
  | "invalid_pin"
  | "unknown";

export interface OverrideErrorInfo {
  code: OverrideErrorCode;
  title: string;
  description: string;
  /** True when the operator can retry after correcting something. */
  retryable: boolean;
}

const CATALOGUE: Record<OverrideErrorCode, Omit<OverrideErrorInfo, "code">> = {
  override_required: {
    title: "Manager approval required",
    description:
      "This reversal is above the configured threshold. Ask a manager to approve before retrying.",
    retryable: true,
  },
  override_not_found: {
    title: "Approval not found",
    description:
      "The approval referenced by this action no longer exists. Request a new manager approval.",
    retryable: true,
  },
  override_not_approved: {
    title: "Approval not granted",
    description:
      "The manager approval was declined or is still pending. Ask a manager to approve before retrying.",
    retryable: true,
  },
  override_already_consumed: {
    title: "Approval already used",
    description:
      "This manager approval was already spent on another action. Request a fresh approval.",
    retryable: true,
  },
  override_expired: {
    title: "Approval expired",
    description:
      "Manager approvals are valid for 15 minutes. Request a new approval and retry.",
    retryable: true,
  },
  override_org_mismatch: {
    title: "Approval belongs to another organization",
    description:
      "The approval was granted for a different organization. Request a new approval in this terminal.",
    retryable: true,
  },
  override_business_mismatch: {
    title: "Approval belongs to another business",
    description:
      "The approval was granted for a different business. Request a new approval in this terminal.",
    retryable: true,
  },
  override_action_mismatch: {
    title: "Wrong approval type",
    description:
      "The manager approved a different kind of action. Request a fresh approval for this reversal.",
    retryable: true,
  },
  override_shift_mismatch: {
    title: "Approval belongs to another shift",
    description:
      "The approval was granted for a different shift. Request a new approval for the current shift.",
    retryable: true,
  },
  override_role_not_allowed: {
    title: "Manager cannot approve this action",
    description:
      "The manager who approved this action does not have the required role. Ask a senior manager.",
    retryable: true,
  },
  invalid_pin: {
    title: "Wrong PIN",
    description: "The PIN you entered does not match. Try again.",
    retryable: true,
  },
  unknown: {
    title: "Reversal blocked",
    description:
      "The reversal was blocked. Contact a manager or check the transaction history for details.",
    retryable: false,
  },
};

const PATTERNS: ReadonlyArray<{ re: RegExp; code: OverrideErrorCode }> = [
  { re: /override_required/i, code: "override_required" },
  { re: /override_not_found/i, code: "override_not_found" },
  { re: /override_not_approved/i, code: "override_not_approved" },
  { re: /override_already_consumed/i, code: "override_already_consumed" },
  { re: /override_expired/i, code: "override_expired" },
  { re: /override_org_mismatch/i, code: "override_org_mismatch" },
  { re: /override_business_mismatch/i, code: "override_business_mismatch" },
  { re: /override_action_mismatch/i, code: "override_action_mismatch" },
  { re: /override_shift_mismatch/i, code: "override_shift_mismatch" },
  { re: /override_role_not_allowed/i, code: "override_role_not_allowed" },
  { re: /invalid[_ ]pin/i, code: "invalid_pin" },
];

export function parseOverrideError(
  error: unknown,
): OverrideErrorInfo {
  const raw =
    (error as { message?: string } | null | undefined)?.message ??
    (typeof error === "string" ? error : "");
  for (const { re, code } of PATTERNS) {
    if (re.test(raw)) {
      return { code, ...CATALOGUE[code] };
    }
  }
  return { code: "unknown", ...CATALOGUE.unknown };
}

export function isOverrideError(error: unknown): boolean {
  return parseOverrideError(error).code !== "unknown";
}

/** Public catalogue for tests / documentation. */
export const OVERRIDE_ERROR_CATALOGUE = CATALOGUE;
