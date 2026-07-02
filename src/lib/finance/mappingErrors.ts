/**
 * Translate Postgres trigger errors thrown by the default-account-mapping
 * pipeline into actionable, user-facing messages.
 *
 * The DB triggers (see migration 20260502151951) return raw messages like:
 *   "Cannot map role \"accounts_receivable\": account 1110/Cash and Cash
 *    Equivalents is a header (group) account and is not postable.
 *    Pick a leaf child instead."
 *
 * That is correct but unfriendly. We rewrite it with concrete remediation
 * (e.g. list the leaf children the user can pick instead).
 */

export interface AccountSummary {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  is_header?: boolean | null;
  is_active?: boolean | null;
  account_type?: string | null;
  detail_type?: string | null;
}

export interface MappingErrorContext {
  /** All accounts in the active business; used to resolve leaf children. */
  accounts?: AccountSummary[];
  /** Optional role label to humanise the role_key in messages. */
  roleLabel?: string;
}

const HEADER_RE =
  /Cannot map role\s+"([^"]+)":?\s+account\s+([^\/]+)\/([^\s]+(?:\s[^\s]+)*?)\s+is a header/i;

const ELIGIBILITY_RE =
  /Account\s+([^\/]+)\/(.+?)\s+\((account_type|detail_type)=([^)]*)\)\s+is not eligible for role\s+"([^"]+)"/i;

/**
 * Convert a raw error (Error or string) thrown by the default-mapping
 * pipeline into a friendly, actionable string.
 * Falls back to the original message when no pattern matches.
 */
export function explainMappingError(
  err: unknown,
  ctx: MappingErrorContext = {},
): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err ?? "");

  const headerMatch = raw.match(HEADER_RE);
  if (headerMatch) {
    const [, roleKey, code, name] = headerMatch;
    const roleLabel = ctx.roleLabel || humaniseRoleKey(roleKey);
    const header = (ctx.accounts ?? []).find(
      (a) => a.code === code.trim(),
    );
    const children = header
      ? (ctx.accounts ?? []).filter(
          (a) =>
            a.parent_id === header.id &&
            a.is_header !== true &&
            a.is_active !== false,
        )
      : [];

    const suggestion =
      children.length > 0
        ? ` Pick one of its child accounts: ${children
            .slice(0, 5)
            .map((c) => `${c.code} ${c.name}`)
            .join(", ")}${children.length > 5 ? ", …" : ""}.`
        : " Create a leaf account under it (or pick a different account with the right detail type).";

    return `“${code.trim()} ${name.trim()}” is a group/parent account and can’t hold transactions, so it can’t be mapped to ${roleLabel}.${suggestion}`;
  }

  const eligMatch = raw.match(ELIGIBILITY_RE);
  if (eligMatch) {
    const [, code, name, field, value, roleKey] = eligMatch;
    const roleLabel = ctx.roleLabel || humaniseRoleKey(roleKey);
    const trimmedCode = code.trim();
    const trimmedName = name.trim();

    // Specifically the detail_type=NULL case — the account was created
    // (likely via CSV import or migration) without a detail type, so it
    // can't be classified for role eligibility. Suggest a sibling account
    // with the same name that IS properly typed, if one exists.
    if (field.toLowerCase() === "detail_type" && /^null$/i.test(value.trim())) {
      const sibling = (ctx.accounts ?? []).find(
        (a) =>
          a.name?.trim().toLowerCase() === trimmedName.toLowerCase() &&
          a.code !== trimmedCode &&
          a.detail_type != null &&
          a.is_active !== false &&
          a.is_header !== true,
      );
      const siblingHint = sibling
        ? ` A properly configured account with the same name already exists: ${sibling.code} ${sibling.name} — map ${roleLabel} to that one instead.`
        : ` Open ${trimmedCode} ${trimmedName} in Accounts and set its Detail Type, or use the “Repair account metadata” button in Settings.`;

      return `“${trimmedCode} ${trimmedName}” has no detail type set, so it can’t be mapped to ${roleLabel}.${siblingHint}`;
    }

    return `“${trimmedCode} ${trimmedName}” is not a valid account for ${roleLabel}. Pick an account whose type and detail type match the role.`;
  }

  return raw;
}

function humaniseRoleKey(key: string): string {
  return key
    .split("_")
    .map((s) => (s.length ? s[0].toUpperCase() + s.slice(1) : s))
    .join(" ");
}