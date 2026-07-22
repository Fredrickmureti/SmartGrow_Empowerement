/**
 * TerminalSessionEnvelope — Stage 1 of the POS refund/reversal remediation
 * (see `.lovable/plan.md` and the audit verdict F1).
 *
 * Single source of truth for the runtime identity of an active POS terminal.
 * Composed from the existing app-wide contexts (Organization, Business,
 * Branch) at the point where a POS surface renders — every downstream
 * mutation hook consumes THIS envelope, not loose `organizationId` /
 * `businessId` scalar arguments.
 *
 * Why:
 *   The reported "Company not selected" bug was caused by call sites
 *   passing `useManagerOverride(currentOrg?.id)` and silently dropping
 *   `businessId`. Fixing that one call site would leave 24+ sibling
 *   hooks one missed argument away from reproducing the same defect.
 *   The envelope replaces the loose-argument contract entirely: hooks
 *   accept `TerminalSessionEnvelope | Partial<TerminalSessionEnvelope>`
 *   and `assertActiveTerminalSession()` produces a *specific* error
 *   (`missing organization`, `missing business`, …) instead of the
 *   blanket "Company not selected" that then got labelled "Override
 *   denied" by the toast handler.
 *
 * Design constraints:
 *   - Immutable for the render (populated once from context, treated
 *     as a value object). Downstream code MUST NOT mutate it.
 *   - Read via `useTerminalSessionEnvelope()` from React tree.
 *     Non-React callers (services, sagas) receive it as an argument.
 *   - No network access; pure composition of ambient contexts. If a
 *     required leg is not hydrated, `ready` is false and the hook's
 *     `assert` will refuse to run mutations.
 *   - Rescue / recovery flows (RescueSessionAlert, ReopenShiftDialog)
 *     operate on OTHER businesses' shifts — they pass explicit
 *     overrides via `Partial<TerminalSessionEnvelope>` rather than
 *     reading the ambient value.
 *
 * See docs/architecture/POS_BRANCH_ISOLATION.md for the branch-scope
 * companion invariant this envelope is designed to compose with.
 */
import { useMemo } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

/**
 * Every field is optional at the type level because a rendering POS
 * surface may not have hydrated every context yet. Consumers gate on
 * `ready` and then use `assertActiveTerminalSession()` to promote the
 * value to a fully-resolved `ActiveTerminalSession` before mutating.
 */
export interface TerminalSessionEnvelope {
  organizationId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  /**
   * The register / shift / cashier legs are populated only inside the
   * terminal shell (they come from `useActivePOSRegister` /
   * `useTerminalSession` in the shift-open flow). Non-terminal POS
   * surfaces (admin, back office) legitimately have these as null.
   */
  registerId?: string | null;
  shiftId?: string | null;
  cashierId?: string | null;
  /** True iff at least org+business are hydrated. */
  ready: boolean;
}

/**
 * The fully-resolved shape returned by `assertActiveTerminalSession`.
 * Every mutation hook accepts `TerminalSessionEnvelope` and asserts on
 * the fields it actually needs, so the type surface stays honest.
 */
export interface ActiveTerminalSession {
  organizationId: string;
  businessId: string;
  branchId: string | null;
  registerId: string | null;
  shiftId: string | null;
  cashierId: string | null;
}

/** Which envelope fields a caller requires. Defaults to org+business. */
export interface AssertRequirements {
  requireBranch?: boolean;
  requireRegister?: boolean;
  requireShift?: boolean;
  requireCashier?: boolean;
}

/**
 * Read the ambient POS terminal identity. Every POS surface calls this
 * (directly or via a mutation hook that consumes it) — do NOT re-derive
 * org/business/branch from separate context hooks at each call site.
 */
export function useTerminalSessionEnvelope(): TerminalSessionEnvelope {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();

  return useMemo<TerminalSessionEnvelope>(() => {
    const organizationId = currentOrg?.id ?? null;
    const businessId = currentBusiness?.id ?? null;
    const branchId = currentBranch?.id ?? null;
    return {
      organizationId,
      businessId,
      branchId,
      registerId: null,
      shiftId: null,
      cashierId: null,
      ready: !!organizationId && !!businessId,
    };
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);
}

/**
 * Merge an ambient envelope with per-call overrides. Rescue / reopen
 * flows use this to target a different business than the ambient one.
 * `undefined` overrides fall through to the ambient value; `null`
 * explicitly clears a field.
 */
export function mergeEnvelope(
  base: TerminalSessionEnvelope,
  overrides?: Partial<TerminalSessionEnvelope>,
): TerminalSessionEnvelope {
  if (!overrides) return base;
  const merged: TerminalSessionEnvelope = {
    ...base,
    ...overrides,
    ready: base.ready, // recomputed below
  };
  merged.ready = !!merged.organizationId && !!merged.businessId;
  return merged;
}

/**
 * Structured error thrown by `assertActiveTerminalSession`. Downstream
 * error handlers (e.g. `useManagerOverride.onError`) inspect `.field`
 * to render specific copy instead of the blanket "Override denied".
 */
export class TerminalSessionMissingFieldError extends Error {
  readonly code = "terminal_session_missing_field";
  constructor(public readonly field: keyof ActiveTerminalSession) {
    super(`Terminal session is missing required field: ${field}`);
    this.name = "TerminalSessionMissingFieldError";
  }
}

/**
 * Promote a `TerminalSessionEnvelope` to a fully-resolved
 * `ActiveTerminalSession` or throw a structured error naming the
 * missing field. Callers pass `requirements` for legs beyond
 * organization + business (which are always required).
 */
export function assertActiveTerminalSession(
  envelope: TerminalSessionEnvelope,
  requirements: AssertRequirements = {},
): ActiveTerminalSession {
  if (!envelope.organizationId) {
    throw new TerminalSessionMissingFieldError("organizationId");
  }
  if (!envelope.businessId) {
    throw new TerminalSessionMissingFieldError("businessId");
  }
  if (requirements.requireBranch && !envelope.branchId) {
    throw new TerminalSessionMissingFieldError("branchId");
  }
  if (requirements.requireRegister && !envelope.registerId) {
    throw new TerminalSessionMissingFieldError("registerId");
  }
  if (requirements.requireShift && !envelope.shiftId) {
    throw new TerminalSessionMissingFieldError("shiftId");
  }
  if (requirements.requireCashier && !envelope.cashierId) {
    throw new TerminalSessionMissingFieldError("cashierId");
  }
  return {
    organizationId: envelope.organizationId,
    businessId: envelope.businessId,
    branchId: envelope.branchId ?? null,
    registerId: envelope.registerId ?? null,
    shiftId: envelope.shiftId ?? null,
    cashierId: envelope.cashierId ?? null,
  };
}

/**
 * Human-readable copy for a missing envelope field. Used by mutation
 * hooks' `onError` handlers to replace the historical blanket
 * "Company not selected" toast with specific, actionable messaging.
 */
export function describeMissingField(
  field: keyof ActiveTerminalSession,
): string {
  switch (field) {
    case "organizationId":
      return "No organization is active. Sign back in and retry.";
    case "businessId":
      return "No business is selected for this terminal. Select a business and retry.";
    case "branchId":
      return "No branch is selected for this terminal. Assign a branch and retry.";
    case "registerId":
      return "No register is active on this terminal.";
    case "shiftId":
      return "No shift is open on this register.";
    case "cashierId":
      return "No cashier is signed in on this terminal.";
  }
}
