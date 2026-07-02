/**
 * Helpers for detecting and presenting self-action (SoD) refusals
 * raised by the Postgres self-approval triggers.
 *
 * Triggers raise SQLSTATE 42501 with HINT 'GOV_SELF_ACTION' (or
 * 'GOV_APPROVER_REQUIRED' / 'GOV_MISSING_PERMISSION') so the UI can
 * recognise them deterministically and show a friendly explainer
 * instead of a raw Postgres error message.
 */

export type GovernanceErrorKind =
  | "self_action_blocked"
  | "approver_required"
  | "missing_permission"
  | "unknown";

export interface GovernanceError {
  kind: GovernanceErrorKind;
  message: string;
  raw: unknown;
}

const HINT_TO_KIND: Record<string, GovernanceErrorKind> = {
  GOV_SELF_ACTION: "self_action_blocked",
  GOV_APPROVER_REQUIRED: "approver_required",
  GOV_MISSING_PERMISSION: "missing_permission",
};

export function parseGovernanceError(error: unknown): GovernanceError | null {
  if (!error || typeof error !== "object") return null;
  const e = error as {
    code?: string;
    hint?: string;
    message?: string;
    details?: string;
  };
  const message = (e.message ?? "").toString();
  const hint = (e.hint ?? "").toString();
  const code = (e.code ?? "").toString();

  // Supabase JS surfaces hints sometimes in `hint`, sometimes inside `message`.
  let kind: GovernanceErrorKind | undefined = HINT_TO_KIND[hint];
  if (!kind) {
    for (const [needle, mapped] of Object.entries(HINT_TO_KIND)) {
      if (message.includes(needle)) {
        kind = mapped;
        break;
      }
    }
  }
  if (!kind && code === "42501" && /self-action|self approval/i.test(message)) {
    kind = "self_action_blocked";
  }
  if (!kind) return null;
  return { kind, message, raw: error };
}

export function isSelfActionBlocked(error: unknown): boolean {
  const g = parseGovernanceError(error);
  return g?.kind === "self_action_blocked";
}

export function describeGovernanceError(g: GovernanceError): {
  title: string;
  body: string;
} {
  switch (g.kind) {
    case "self_action_blocked":
      return {
        title: "Self-approval blocked",
        body:
          "This action cannot be approved by the same user who created it. " +
          "Ask a different authorized user to approve, or have an owner create a " +
          "one-time co-signed override from Settings → Workspace → Governance.",
      };
    case "approver_required":
      return {
        title: "Approver missing",
        body:
          "The system expects an approver to be recorded for this transition. " +
          "Use the dedicated Approve action instead of editing the status directly.",
      };
    case "missing_permission":
      return {
        title: "Missing permission",
        body:
          "The approver does not have permission to approve this kind of record. " +
          "Grant the relevant permission via Access Groups or ask an admin to approve.",
      };
    default:
      return { title: "Action blocked", body: g.message };
  }
}
