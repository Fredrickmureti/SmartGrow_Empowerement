/**
 * Vendor statement send-queue drainer — the AP mirror of
 * `flushStatementSendOutbox.ts`.
 *
 * Bulk vendor-statement delivery is a durable, server-owned job, never a
 * browser loop. `vendor_statement_send_jobs` holds one row per (statement,
 * recipient) with a unique idempotency key, so a re-run of the batch, a
 * double click, or a worker retry can never produce a second email for a
 * statement that already went out.
 *
 * Claiming uses `claim_vendor_statement_send_jobs` (FOR UPDATE SKIP LOCKED +
 * exponential backoff reservation), so concurrent workers never take the same
 * job and a worker that dies mid-send releases its job automatically.
 *
 * Rendering and the audit trail are NOT reimplemented here: each job is handed
 * to `send-document-email`, which renders the statement PDF and writes the
 * outcome to `document_emails` on both the success and the failure path.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const BATCH = 15;

export interface VendorStatementFlushResult {
  processed: number;
  sent: number;
  failed: number;
}

interface JobRow {
  id: string;
  statement_id: string;
  recipient_email: string;
  subject: string;
  message: string | null;
  attempts: number;
  max_attempts: number;
}

async function complete(
  supabase: SupabaseClient,
  jobId: string,
  success: boolean,
  error?: string,
): Promise<void> {
  const { error: rpcError } = await supabase.rpc("complete_vendor_statement_send_job", {
    _job_id: jobId,
    _success: success,
    _error: error ?? null,
  });
  if (rpcError) {
    console.error("[vendor-statement-send] failed to record job outcome:", rpcError.message);
  }
}

export async function flushVendorStatementSendOutbox(
  supabaseUrl: string,
  serviceKey: string,
): Promise<VendorStatementFlushResult> {
  const supabase = createClient(supabaseUrl, serviceKey);
  const result: VendorStatementFlushResult = { processed: 0, sent: 0, failed: 0 };

  const { data: jobs, error } = await supabase.rpc("claim_vendor_statement_send_jobs", {
    _limit: BATCH,
  });
  if (error) {
    console.error("[vendor-statement-send] claim failed:", error.message);
    return result;
  }

  for (const job of (jobs || []) as JobRow[]) {
    result.processed++;
    try {
      const { data, error: sendError } = await supabase.functions.invoke(
        "send-document-email",
        {
          body: {
            documentType: "vendor_statement",
            documentId: job.statement_id,
            to: job.recipient_email,
            subject: job.subject,
            body: job.message ?? "",
          },
        },
      );
      if (sendError) throw sendError;
      if (data && (data as { error?: string }).error) {
        throw new Error((data as { error: string }).error);
      }
      await complete(supabase, job.id, true);
      result.sent++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        `[vendor-statement-send] job ${job.id} attempt ${job.attempts} failed:`,
        message,
      );
      await complete(supabase, job.id, false, message.slice(0, 1000));
      result.failed++;
    }
  }

  return result;
}
