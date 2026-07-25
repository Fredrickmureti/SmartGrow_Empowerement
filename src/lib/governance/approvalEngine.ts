/**
 * Canonical client entry points for the Approval & Governance engine.
 *
 * Modules MUST go through these two helpers — direct writes to
 * `approval_requests` / `approval_history` are revoked from
 * `authenticated` at the database level (Phase 3 migration).
 *
 *   - routeApproval:  creates (or replays) an approval request for a
 *                     given registered action key + subject.
 *   - decideApproval: records an approver decision. Blocks self-approval
 *                     through the existing governance framework.
 *
 * Errors from the RPCs are Postgres errors; use `parseGovernanceError`
 * from `selfActionErrors.ts` to render friendly SoD refusals.
 */
import { supabase } from "@/integrations/supabase/client";

export type ApprovalDecision = "approve" | "reject" | "cancel";

export interface RouteApprovalArgs {
  actionKey: string;
  entityType: string;
  entityId: string;
  entityReference?: string | null;
  payload?: Record<string, unknown>;
  context?: Record<string, unknown>;
  idempotencyKey?: string | null;
  businessId?: string | null;
}

export interface ApprovalRequestRow {
  id: string;
  organization_id: string;
  business_id: string | null;
  action_key: string | null;
  entity_type: string;
  entity_id: string;
  status: string;
  requested_by: string | null;
  requested_at: string | null;
  completed_at: string | null;
  current_step: number | null;
}

/**
 * Route an event through the engine.
 *
 * Returns `null` when policy does not gate this action (no matching rule
 * and the registry does not mark it `requires_approval_always`) — callers
 * treat `null` as "proceed immediately".
 */
export async function routeApproval(
  args: RouteApprovalArgs,
): Promise<ApprovalRequestRow | null> {
  const { data, error } = await (supabase as any).rpc("approval_route", {
    _action_key: args.actionKey,
    _entity_type: args.entityType,
    _entity_id: args.entityId,
    _entity_reference: args.entityReference ?? null,
    _payload: args.payload ?? {},
    _context: args.context ?? {},
    _idempotency_key: args.idempotencyKey ?? null,
    _business_id: args.businessId ?? null,
  });
  if (error) throw error;
  return data as ApprovalRequestRow;
}

/**
 * Record an approver decision.
 *
 * `clientToken` is the replay guard: the engine stores it on the
 * `approval_history` event, so a double-submit (retry, double click,
 * offline replay) collapses onto the first decision instead of
 * consuming a second quorum slot. Callers that don't pass one get a
 * fresh token per invocation.
 */
export async function decideApproval(
  requestId: string,
  decision: ApprovalDecision,
  comment?: string,
  clientToken?: string,
): Promise<ApprovalRequestRow> {
  const { data, error } = await (supabase as any).rpc("approval_decide", {
    _request_id: requestId,
    _decision: decision,
    _comment: comment ?? null,
    _client_token: clientToken ?? crypto.randomUUID(),
  });
  if (error) throw error;
  return data as ApprovalRequestRow;
}

/**
 * Read-only integrity check for the append-only, hash-chained
 * `approval_history` of a single request. Powers the "chain verified"
 * badge on approval detail pages and the nightly integrity monitor.
 */
export async function verifyApprovalHistory(requestId: string) {
  const { data, error } = await (supabase as any).rpc("approval_history_verify", {
    _request_id: requestId,
  });
  if (error) throw error;
  return (data ?? []) as Array<{ event_seq: number; ok: boolean; reason: string | null }>;
}
