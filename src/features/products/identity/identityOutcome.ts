/**
 * Product Identity — operator-facing outcome taxonomy (ADR-0110).
 *
 * `resolve_product_identity` returns a DECISION, not a row set: every scan
 * ends in exactly one status. This module is the single place that turns
 * that status into operator copy plus a remediation path. No capture
 * surface may author its own wording for a resolution failure — POS, WMS,
 * Inventory and Sales all read from here, so the same code produces the
 * same sentence everywhere.
 *
 * Infrastructure detail (RPC names, SQLSTATEs, PostgREST codes) never
 * reaches this copy.
 */
export type IdentityStatus =
  | "resolved"
  | "ambiguous"
  | "not_found"
  | "inactive"
  | "archived"
  | "expired"
  | "foreign_tenant"
  | "unauthorized"
  | "error";

export const IDENTITY_STATUSES: readonly IdentityStatus[] = [
  "resolved",
  "ambiguous",
  "not_found",
  "inactive",
  "archived",
  "expired",
  "foreign_tenant",
  "unauthorized",
  "error",
] as const;

/** Remediation the operator (or their supervisor) can actually perform. */
export type IdentityRemediation =
  | { action: "none" }
  | { action: "enrol"; label: string; href: string }
  | { action: "review_duplicate"; label: string; href: string }
  | { action: "reactivate"; label: string; href: string }
  | { action: "retry"; label: string }
  | { action: "contact_admin"; label: string };

export interface IdentityOutcomeCopy {
  /** One-line headline for a toast, flash bar or scan ticker. */
  title: string;
  /** Sentence explaining what the operator should do next. */
  detail: string;
  remediation: IdentityRemediation;
  /** True when the scan must not post stock or add a line. */
  blocking: boolean;
}

const ENROL_HREF = "/inventory/products/enroll";

export interface IdentityOutcomeInput {
  status: IdentityStatus;
  code: string;
  /** Number of live identifiers that matched (ambiguous only). */
  matchCount?: number;
  /** Product name, when the resolver still returned a best candidate. */
  productName?: string | null;
}

export function describeIdentityOutcome(input: IdentityOutcomeInput): IdentityOutcomeCopy {
  const code = (input.code || "").trim() || "that code";
  switch (input.status) {
    case "resolved":
      return {
        title: input.productName || code,
        detail: "Identifier resolved.",
        remediation: { action: "none" },
        blocking: false,
      };
    case "ambiguous":
      return {
        title: `${code} is registered more than once`,
        detail: `${input.matchCount ?? 2} active identifiers share this code, so the product cannot be determined. Retire the duplicate before scanning it again.`,
        remediation: { action: "review_duplicate", label: "Review duplicates", href: ENROL_HREF },
        blocking: true,
      };
    case "not_found":
      return {
        title: `${code} is not registered`,
        detail:
          "No product in this business carries this identifier. Enrol it against the right product and packaging level first.",
        remediation: { action: "enrol", label: "Enrol this code", href: ENROL_HREF },
        blocking: true,
      };
    case "inactive":
      return {
        title: `${code} is switched off`,
        detail:
          "This identifier exists but is marked inactive, so it no longer resolves to a product. Reactivate it if the label is still in circulation.",
        remediation: { action: "reactivate", label: "Manage identifiers", href: ENROL_HREF },
        blocking: true,
      };
    case "archived":
      return {
        title: `${code} has been retired`,
        detail:
          "This identifier was archived and may have been replaced by a newer code. Check the product's identifiers, or scan the current label.",
        remediation: { action: "reactivate", label: "Manage identifiers", href: ENROL_HREF },
        blocking: true,
      };
    case "expired":
      return {
        title: `${code} is outside its valid dates`,
        detail:
          "This identifier is registered but is not valid today. Extend its validity or scan the current label.",
        remediation: { action: "reactivate", label: "Manage identifiers", href: ENROL_HREF },
        blocking: true,
      };
    case "foreign_tenant":
      return {
        title: `${code} belongs to another organisation`,
        detail:
          "This identifier is registered outside this business, so it cannot be used here. Enrol your own code for this item.",
        remediation: { action: "enrol", label: "Enrol this code", href: ENROL_HREF },
        blocking: true,
      };
    case "unauthorized":
      return {
        title: "You cannot look up items for this business",
        detail:
          "Your account does not have access to this business's catalogue. Ask an administrator to grant access.",
        remediation: { action: "contact_admin", label: "Contact an administrator" },
        blocking: true,
      };
    case "error":
    default:
      return {
        title: `${code} could not be checked`,
        detail:
          "The catalogue did not answer in time. The line is held rather than guessed — scan again in a moment.",
        remediation: { action: "retry", label: "Scan again" },
        blocking: true,
      };
  }
}

/** Compact one-liner for flash bars and scan tickers. */
export function identityOutcomeLine(input: IdentityOutcomeInput): string {
  const c = describeIdentityOutcome(input);
  return `${c.title} — ${c.detail}`;
}