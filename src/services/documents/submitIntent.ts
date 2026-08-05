/**
 * enqueueDocumentIntent — server-side routing-plan enqueue.
 *
 * INTERNAL to the printing pipeline: the only sanctioned caller is
 * `PrintService.printDocumentIntent`. App code never enqueues jobs
 * directly, because an enqueue on its own leaves the operator waiting
 * for the recovery sweeper instead of printing now.
 *
 * It asks the server to dispatch a Document Record.
 * It never renders bytes, never opens a print dialog, never touches
 * hardware directly. All it does is ask the server to:
 *   1. Resolve the Wave 4 routing plan (which media and dispositions apply).
 *   2. Enqueue one `print_jobs` row per target.
 *
 * Downstream workers (Wave 6+) drain those job rows: they render the bytes
 * via the shared rendering engine and route them through the correct
 * disposition (print / email / download / archive / fiscal).
 *
 * Legacy paths (`useDocumentPrint` direct edge invocation, POS commit sagas
 * calling PrintClient, per-module label spooler calls, etc.) are shadow
 * paths scheduled for Wave 9 deletion. Nothing new should use them.
 */
import { supabase } from "@/integrations/supabase/client";
import type { EnsureDocumentRecordInput } from "./ensureDocumentRecord";

export interface SubmitDocumentIntentInput {
  documentRecordId: string;
  scenario?: string;
  triggeredSource?: "business_event" | "manual" | "reprint" | "api";
}

export interface SubmitDocumentIntentResult {
  document_record_id: string;
  intent_id: string | null;
  scenario: string;
  job_ids: string[];
  target_count: number;
}

export async function enqueueDocumentIntent(
  input: SubmitDocumentIntentInput,
): Promise<SubmitDocumentIntentResult> {
  const { data, error } = await supabase.functions.invoke(
    "submit-document-intent",
    {
      body: {
        document_record_id: input.documentRecordId,
        scenario: input.scenario ?? "default",
        triggered_source: input.triggeredSource ?? "api",
      },
    },
  );

  if (error) {
    throw new Error(`document intent enqueue failed: ${error.message}`);
  }
  return data as SubmitDocumentIntentResult;
}

/**
 * Phase 3 (POS latency): materialize + enqueue in ONE round trip.
 *
 * `ensureDocumentRecord` → `submit-document-intent` (edge) → `loadJobs`
 * → `resolveOrganizationId` was four sequential hops, one of them an Edge
 * Function cold boot, for work that is a single transaction server-side.
 * `document_materialize_and_submit_intent` does all of it in one RPC and
 * hands back the enqueued rows, so the foreground dispatcher can start
 * rendering immediately.
 *
 * Same authorisation as before: the RPC is SECURITY DEFINER and rejects
 * callers who are not members of the owning organization.
 */
export interface MaterializeAndSubmitIntentResult extends SubmitDocumentIntentResult {
  organization_id: string | null;
  /** The `print_jobs` rows just enqueued, in creation order. */
  jobs: Array<Record<string, unknown>>;
}

export async function materializeAndSubmitIntent(
  input: EnsureDocumentRecordInput & {
    scenario?: string;
    triggeredSource?: "business_event" | "manual" | "reprint" | "api";
  },
): Promise<MaterializeAndSubmitIntentResult> {
  const { data, error } = await supabase.rpc(
    "document_materialize_and_submit_intent" as never,
    {
      p_kind_code: input.kindCode,
      p_organization_id: input.organizationId,
      p_source_module: input.sourceModule,
      p_source_doc_type: input.sourceDocType,
      p_source_doc_id: input.sourceDocId,
      p_business_id: input.businessId ?? null,
      p_branch_id: input.branchId ?? null,
      p_party_kind: input.partyKind ?? null,
      p_party_id: input.partyId ?? null,
      p_currency: input.currency ?? null,
      p_locale: input.locale ?? null,
      p_metadata: input.metadata ?? {},
      p_document_number: input.documentNumber ?? null,
      p_document_date: input.documentDate ?? null,
      p_snapshot: input.snapshot ?? null,
      p_scenario: input.scenario ?? "default",
      p_triggered_source: input.triggeredSource ?? "api",
    } as never,
  );

  if (error) {
    throw new Error(`document intent enqueue failed: ${error.message}`);
  }
  const result = data as unknown as MaterializeAndSubmitIntentResult | null;
  if (!result?.document_record_id) {
    throw new Error(
      `document intent enqueue returned unexpected payload: ${JSON.stringify(data)}`,
    );
  }
  return {
    ...result,
    job_ids: result.job_ids ?? [],
    jobs: result.jobs ?? [],
  };
}
