// @ts-nocheck — Deno runtime
/**
 * submit-statutory-return (Slice G — E-filing dispatcher)
 *
 * Metadata-driven authority dispatcher. Reads the return template's
 * `api_endpoint_spec`, `digital_signature_spec`, and `acknowledgement_spec`
 * to compose, sign, and POST the payload to the statutory authority. Zero
 * per-country code: a new authority is onboarded by publishing pack metadata,
 * never by editing this function.
 *
 *   api_endpoint_spec = {
 *     url_template: string,            // may include {period_start}, {period_end}
 *     method?: "POST"|"PUT",
 *     auth_scheme?: "none"|"bearer"|"hmac_sha256"|"api_key",
 *     auth_secret_name?: string,       // Deno env var name (never the value)
 *     payload_kind?: "gov_file"|"json", // gov_file streams the rendered file
 *     content_type?: string,
 *     headers?: Record<string,string>
 *   }
 *
 *   digital_signature_spec = {
 *     method: "none"|"hmac_sha256"|"x509",
 *     secret_name?: string,
 *     header_name?: string             // e.g. "X-Signature"
 *   }
 *
 *   acknowledgement_spec = {
 *     mode: "sync"|"async"|"none",
 *     reference_path?: string,         // jsonpath into response body
 *     accepted_status?: number[]       // default [200,201,202]
 *   }
 *
 * On success transitions the run to `submitted_awaiting_ack` (or `acknowledged`
 * if mode='sync' and accepted). All outcomes are written to
 * payroll_return_filing_events for audit.
 *
 * Until a real authority is wired, set api_endpoint_spec.url_template to a
 * synthetic echo endpoint (e.g. https://httpbin.org/post) — the contract is
 * already enforced.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function hmacSha256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function interpolate(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

function getByPath(obj: any, path: string): unknown {
  return path.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthenticated" }, 401);

    const body = await req.json();
    if (!body?.run_id) return json({ error: "run_id required" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: run, error: rErr } = await admin
      .from("payroll_return_runs")
      .select("*")
      .eq("id", body.run_id)
      .maybeSingle();
    if (rErr || !run) return json({ error: "run not found" }, 404);

    const { data: perm } = await admin.rpc("user_has_module_permission", {
      _user_id: user.id,
      _org_id: run.organization_id,
      _module: "financials",
      _operation: "write",
    });
    if (!perm) return json({ error: "permission denied" }, 403);

    // Resolve template (pack/override)
    const { data: tpl } = await admin
      .from("localization_pack_return_templates")
      .select("api_endpoint_spec, digital_signature_spec, acknowledgement_spec, approval_required, submission_channel, code")
      .eq("code", run.template_code)
      .eq("pack_id", run.template_pack_id)
      .maybeSingle();
    if (!tpl?.api_endpoint_spec) return json({ error: "template has no api_endpoint_spec" }, 400);

    const apiSpec = tpl.api_endpoint_spec as any;
    const sigSpec = (tpl.digital_signature_spec ?? { method: "none" }) as any;
    const ackSpec = (tpl.acknowledgement_spec ?? { mode: "sync" }) as any;

    // Build URL + body
    const url = interpolate(String(apiSpec.url_template ?? ""), {
      period_start: run.period_start,
      period_end: run.period_end,
      template_code: run.template_code,
    });
    if (!/^https:\/\//.test(url)) return json({ error: "url_template must be https://" }, 400);

    let payloadBytes: Uint8Array;
    let contentType = apiSpec.content_type ?? "application/json";
    // ADR 0060 — the gov filing file now lives in run.artifacts, not the
    // legacy scalar gov_file_path column (dropped 2026-07-12). Prefer the
    // artifact whose role is "portal", then any gov_* format.
    const artifacts: Array<{ format?: string; path?: string; role?: string }> =
      Array.isArray(run.artifacts) ? run.artifacts : [];
    const govArtifact =
      artifacts.find((a) => a?.role === "portal" && typeof a?.path === "string") ??
      artifacts.find((a) => typeof a?.format === "string" && /^gov_/i.test(a.format) && typeof a?.path === "string") ??
      null;
    if (apiSpec.payload_kind === "gov_file" && govArtifact?.path) {
      const dl = await admin.storage.from("documents").download(govArtifact.path);
      if (dl.error || !dl.data) return json({ error: `gov_file download: ${dl.error?.message}` }, 500);
      payloadBytes = new Uint8Array(await dl.data.arrayBuffer());
    } else if (apiSpec.payload_kind === "gov_file") {
      return json({
        error: "gov_file payload required but no portal-role artifact found on this run",
      }, 400);
    } else {
      const txt = JSON.stringify(run.payload);
      payloadBytes = new TextEncoder().encode(txt);
    }

    // Auth & signature headers
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      ...(apiSpec.headers ?? {}),
    };
    if (apiSpec.auth_scheme === "bearer" && apiSpec.auth_secret_name) {
      const t = Deno.env.get(apiSpec.auth_secret_name);
      if (!t) return json({ error: `secret ${apiSpec.auth_secret_name} not configured` }, 500);
      headers["Authorization"] = `Bearer ${t}`;
    } else if (apiSpec.auth_scheme === "api_key" && apiSpec.auth_secret_name) {
      const t = Deno.env.get(apiSpec.auth_secret_name);
      if (!t) return json({ error: `secret ${apiSpec.auth_secret_name} not configured` }, 500);
      headers[apiSpec.auth_header_name ?? "X-Api-Key"] = t;
    }
    if (sigSpec.method === "hmac_sha256" && sigSpec.secret_name) {
      const s = Deno.env.get(sigSpec.secret_name);
      if (!s) return json({ error: `signing secret ${sigSpec.secret_name} not configured` }, 500);
      const sig = await hmacSha256(s, new TextDecoder().decode(payloadBytes));
      headers[sigSpec.header_name ?? "X-Signature"] = sig;
    }

    const startedAt = new Date().toISOString();
    let resp: Response;
    try {
      resp = await fetch(url, { method: apiSpec.method ?? "POST", headers, body: payloadBytes });
    } catch (e: any) {
      await admin.from("payroll_return_filing_events").insert({
        run_id: run.id,
        organization_id: run.organization_id,
        business_id: run.business_id,
        event: "dispatch_failed",
        actor_id: user.id,
        payload: { error: e?.message ?? String(e), url, started_at: startedAt },
      });
      return json({ error: `dispatch failed: ${e?.message ?? e}` }, 502);
    }

    const respText = await resp.text();
    let respJson: any = null;
    try { respJson = JSON.parse(respText); } catch { /* not JSON */ }

    const acceptedStatuses: number[] = Array.isArray(ackSpec.accepted_status) && ackSpec.accepted_status.length
      ? ackSpec.accepted_status
      : [200, 201, 202];
    const accepted = acceptedStatuses.includes(resp.status);
    const authorityRef = ackSpec.reference_path && respJson
      ? String(getByPath(respJson, ackSpec.reference_path) ?? "")
      : null;

    await admin.from("payroll_return_filing_events").insert({
      run_id: run.id,
      organization_id: run.organization_id,
      business_id: run.business_id,
      event: accepted ? "dispatch_accepted" : "dispatch_rejected",
      actor_id: user.id,
      payload: {
        url, http_status: resp.status, started_at: startedAt,
        ended_at: new Date().toISOString(),
        response_snippet: respText.slice(0, 4096),
        authority_reference: authorityRef,
      },
    });

    if (!accepted) {
      return json({ error: `authority rejected (HTTP ${resp.status})`, response: respText.slice(0, 2048) }, 502);
    }

    // Transition the run through the sole sanctioned mutation path
    // (payroll_return_transition). This RPC runs the CHECK matrix,
    // applies the metadata payload, writes pack_return_run_audit, and
    // fires the AFTER-trigger that emits `return.state_changed` into
    // business_event_outbox in the SAME transaction. Direct UPDATEs
    // here would skip the audit + outbox and break the state machine
    // guard.
    //
    // Sync ack flow → 'acknowledged'; async ack flow → 'filed' (the
    // ack itself later transitions filed → acknowledged via
    // record-return-filing).
    const toStatus = ackSpec.mode === "sync" ? "acknowledged" : "filed";
    const nowIso = new Date().toISOString();
    const transitionPayload: Record<string, unknown> = {
      submitted_at: nowIso,
      submitted_by: user.id,
      submission_channel: tpl.submission_channel ?? "api",
      authority_ack_payload: { http_status: resp.status, body: respJson ?? respText.slice(0, 2048) },
      filed_at: nowIso,
    };
    if (toStatus === "acknowledged") {
      transitionPayload.acknowledged_at = nowIso;
      if (authorityRef) transitionPayload.filed_reference = authorityRef;
    } else if (authorityRef) {
      transitionPayload.filed_reference = authorityRef;
    }

    // Two-step for async: generated|draft → filed → (later) acknowledged.
    // The RPC forbids draft → filed directly, so we escalate through
    // 'generated' when the run is still a draft. Both edges are legal
    // in the state machine.
    if (run.status === "draft") {
      const { error: gErr } = await admin.rpc("payroll_return_transition", {
        _run_id: run.id, _to_status: "generated", _reason: "auto-promote for submit", _payload: {},
      });
      if (gErr) return json({ error: gErr.message, code: "INVALID_TRANSITION" }, 409);
    }

    const { error: trErr } = await admin.rpc("payroll_return_transition", {
      _run_id: run.id,
      _to_status: toStatus,
      _reason: `authority ack (${ackSpec.mode ?? "sync"})`,
      _payload: transitionPayload,
    });
    if (trErr) return json({ error: trErr.message, code: "INVALID_TRANSITION" }, 409);

    return json({ ok: true, http_status: resp.status, authority_reference: authorityRef, to_status: toStatus });
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
});
