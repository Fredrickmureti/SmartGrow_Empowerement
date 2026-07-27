/**
 * Wave 6 — dispatch-print-jobs
 *
 * The single drainer for `print_jobs`. Invoked by pg_cron every ~30s
 * (and callable manually by platform admins for on-demand drains).
 * Runs under service role.
 *
 * Per invocation:
 *   1. Atomically claim a batch of `queued` rows (SKIP LOCKED, back-off aware).
 *   2. For each claimed job:
 *        a. Ensure a rendered artifact exists (invoke render-document).
 *        b. Route by disposition:
 *             print    → resolve role → hardware_command_queue
 *             email    → email_event_outbox
 *             fiscal   → fiscal_transmissions
 *             webhook  → business_event_outbox
 *             download / archive → mark dispatched (artifact suffices).
 *        c. Call mark_print_job_dispatched or mark_print_job_failed.
 *
 * All state transitions go through SECURITY DEFINER RPCs so the drainer
 * never writes `print_jobs.status` directly — this keeps the DLQ /
 * back-off contract in one place.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEFAULT_BATCH_SIZE = 25;

type PrintJob = {
  id: string;
  business_id: string;
  branch_id: string | null;
  document_record_id: string | null;
  output_intent_target_id: string | null;
  artifact_id: string | null;
  disposition: string | null;
  medium: string | null;
  hardware_role: string | null;
  copies: number;
  scenario: string;
  render_params: Record<string, unknown>;
  correlation_id: string;
  doc_type: string;
  doc_id: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const authFailure = requireCronAuth(req);
  if (authFailure) return authFailure;

  let batchSize = DEFAULT_BATCH_SIZE;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.batch_size === "number" && body.batch_size > 0) {
      batchSize = Math.min(body.batch_size, 100);
    }
  } catch {
    /* body optional */
  }

  const { data: claimed, error: claimErr } = await admin.rpc("claim_print_jobs", {
    p_batch_size: batchSize,
  });

  if (claimErr) {
    console.error("[dispatch-print-jobs] claim failed", claimErr);
    return jsonResponse({ error: "claim_failed", detail: claimErr.message }, 500);
  }

  const jobs = (claimed ?? []) as PrintJob[];
  const results: Array<{ job_id: string; status: string; error?: string }> = [];

  for (const job of jobs) {
    try {
      const outcome = await processJob(job);
      results.push({ job_id: job.id, status: outcome });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[dispatch-print-jobs] job ${job.id} failed:`, message);
      await admin.rpc("mark_print_job_failed", {
        p_job_id: job.id,
        p_error: message.slice(0, 500),
      });
      results.push({ job_id: job.id, status: "failed", error: message });
    }
  }

  return jsonResponse({
    claimed: jobs.length,
    results,
  });
});

// ---------------------------------------------------------------------------

async function processJob(job: PrintJob): Promise<string> {
  // 1. Ensure an artifact exists for anything that needs bytes downstream.
  let artifactId = job.artifact_id;
  const needsArtifact =
    !artifactId &&
    job.document_record_id &&
    job.disposition !== "webhook"; // webhook payload is metadata only

  if (needsArtifact) {
    artifactId = await renderArtifact(job);
  }

  // 2. Dispatch by disposition.
  switch (job.disposition) {
    case "print":
      return dispatchPrint(job, artifactId);
    case "email":
      return dispatchEmail(job, artifactId);
    case "fiscal":
      return dispatchFiscal(job, artifactId);
    case "webhook":
      return dispatchWebhook(job);
    case "download":
    case "archive":
      await markDispatched(job.id, artifactId, null);
      return "dispatched";
    default:
      throw new Error(`unknown_disposition:${job.disposition}`);
  }
}

async function renderArtifact(job: PrintJob): Promise<string> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/render-document`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      medium: job.medium ?? "pdf",
      document_id: job.document_record_id,
      options: job.render_params ?? {},
      persist: true,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => resp.statusText);
    throw new Error(`render_failed:${resp.status}:${detail.slice(0, 200)}`);
  }

  const envelope = await resp.json().catch(() => null);
  const artifactId: string | undefined =
    envelope?.artifact_id ?? envelope?.artifact?.id;
  if (!artifactId) {
    throw new Error("render_returned_no_artifact_id");
  }
  return artifactId;
}

async function dispatchPrint(job: PrintJob, artifactId: string | null): Promise<string> {
  if (!job.hardware_role || job.hardware_role === "virtual") {
    // Virtual print target — nothing to send to a device.
    await markDispatched(job.id, artifactId, null);
    return "dispatched_virtual";
  }

  if (!job.branch_id) {
    throw new Error("print_requires_branch_id");
  }

  const { data: doc } = await admin
    .from("document_records")
    .select("organization_id")
    .eq("id", job.document_record_id!)
    .maybeSingle();

  if (!doc?.organization_id) {
    throw new Error("cannot_resolve_org_for_print");
  }

  const { data: candidates, error: resolveErr } = await admin.rpc(
    "resolve_hardware_assignment",
    {
      p_organization_id: doc.organization_id,
      p_branch_id: job.branch_id,
      p_role_code: job.hardware_role,
    },
  );
  if (resolveErr) throw new Error(`resolve_role_failed:${resolveErr.message}`);

  const chosen = (candidates ?? [])[0];
  if (!chosen) {
    throw new Error(`no_device_bound_for_role:${job.hardware_role}`);
  }

  const idempotencyKey = `job:${job.id}`;
  const { data: cmdRows, error: enqErr } = await admin
    .from("hardware_command_queue")
    .insert({
      org_id: doc.organization_id,
      branch_id: job.branch_id,
      device_assignment_id: chosen.device_assignment_id,
      role: job.hardware_role,
      op: "print",
      payload: {
        artifact_id: artifactId,
        medium: job.medium,
        copies: job.copies,
        correlation_id: job.correlation_id,
        doc_type: job.doc_type,
        doc_id: job.doc_id,
      },
      idempotency_key: idempotencyKey,
      source_doc_type: job.doc_type,
      source_doc_id: job.doc_id,
    })
    .select("id")
    .single();

  if (enqErr) throw new Error(`hw_queue_enqueue_failed:${enqErr.message}`);

  await markDispatched(job.id, artifactId, cmdRows.id as number);
  return "dispatched_to_hardware";
}

async function dispatchEmail(job: PrintJob, artifactId: string | null): Promise<string> {
  const { data: doc } = await admin
    .from("document_records")
    .select("organization_id, business_id, party_kind, party_id, kind_code")
    .eq("id", job.document_record_id!)
    .maybeSingle();
  if (!doc) throw new Error("email_missing_document_record");

  const { error } = await admin.from("email_event_outbox").insert({
    organization_id: doc.organization_id,
    business_id: doc.business_id,
    event_type: `document.${doc.kind_code}.dispatch`,
    entity_type: "document_record",
    entity_id: job.document_record_id,
    template_variables: {
      artifact_id: artifactId,
      document_record_id: job.document_record_id,
      correlation_id: job.correlation_id,
      scenario: job.scenario,
    },
    status: "pending",
  });
  if (error) throw new Error(`email_outbox_enqueue_failed:${error.message}`);

  await markDispatched(job.id, artifactId, null);
  return "dispatched_to_email";
}

async function dispatchFiscal(job: PrintJob, artifactId: string | null): Promise<string> {
  const { data: doc } = await admin
    .from("document_records")
    .select("organization_id, business_id, branch_id, kind_code, source_doc_type, source_doc_id")
    .eq("id", job.document_record_id!)
    .maybeSingle();
  if (!doc) throw new Error("fiscal_missing_document_record");

  const { error } = await admin.from("fiscal_transmissions").insert({
    organization_id: doc.organization_id,
    business_id: doc.business_id,
    branch_id: doc.branch_id,
    document_kind: doc.kind_code,
    source_doc_type: doc.source_doc_type ?? doc.kind_code,
    source_doc_id: doc.source_doc_id ?? job.document_record_id,
    idempotency_key: `job:${job.id}`,
    state: "pending",
    payload: {
      artifact_id: artifactId,
      correlation_id: job.correlation_id,
      scenario: job.scenario,
    },
  });
  if (error) throw new Error(`fiscal_enqueue_failed:${error.message}`);

  await markDispatched(job.id, artifactId, null);
  return "dispatched_to_fiscal";
}

async function dispatchWebhook(job: PrintJob): Promise<string> {
  const { data: doc } = await admin
    .from("document_records")
    .select("organization_id, branch_id, kind_code")
    .eq("id", job.document_record_id!)
    .maybeSingle();
  if (!doc) throw new Error("webhook_missing_document_record");

  const { error } = await admin.from("business_event_outbox").insert({
    org_id: doc.organization_id,
    branch_id: doc.branch_id,
    event_type: `document.${doc.kind_code}.dispatched`,
    source_doc_type: "document_record",
    source_doc_id: job.document_record_id,
    payload: {
      correlation_id: job.correlation_id,
      scenario: job.scenario,
      params: job.render_params,
    },
    status: "pending",
    handler_scope: "server",
    idempotency_key: `job:${job.id}`,
  });
  if (error) throw new Error(`webhook_outbox_failed:${error.message}`);

  await markDispatched(job.id, null, null);
  return "dispatched_to_webhook";
}

async function markDispatched(
  jobId: string,
  artifactId: string | null,
  hwCommandId: number | null,
): Promise<void> {
  const { error } = await admin.rpc("mark_print_job_dispatched", {
    p_job_id: jobId,
    p_artifact_id: artifactId,
    p_hw_command_id: hwCommandId,
  });
  if (error) throw new Error(`mark_dispatched_failed:${error.message}`);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
