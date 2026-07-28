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
