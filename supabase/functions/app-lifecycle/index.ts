/**
 * app-lifecycle — single dispatcher for app installation, uninstallation,
 * trial management, and install previews.
 *
 * Strategy: under near-cap edge-function conditions, we collapse what would
 * normally be 5 separate functions into one. Each action is a thin wrapper
 * around a Postgres RPC; business logic lives in DB so it is uniformly
 * enforced (RLS + SECURITY DEFINER + audit-able).
 *
 * Body: { action: 'install' | 'uninstall' | 'start_trial' | 'preview_install_impact', ... }
 *
 * Auth: caller's JWT is forwarded; the underlying RPCs do their own
 * owner/admin authorization via auth.uid().
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface InstallBody {
  action: "install";
  organization_id: string;
  app_id: string;
}
interface UninstallBody {
  action: "uninstall";
  organization_id: string;
  app_id: string;
}
interface StartTrialBody {
  action: "start_trial";
  organization_id: string;
  app_id: string;
  days?: number;
}
interface PreviewBody {
  action: "preview_install_impact";
  organization_id: string;
  app_id: string;
}
type Body = InstallBody | UninstallBody | StartTrialBody | PreviewBody;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: auth } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body || !body.action) return json({ error: "Missing action" }, 400);
    if (!body.organization_id || !body.app_id) {
      return json({ error: "organization_id and app_id required" }, 400);
    }

    // Resolve caller's user id once (used for durable failure logging).
    let callerUserId: string | null = null;
    try {
      const { data: u } = await userClient.auth.getUser();
      callerUserId = u?.user?.id ?? null;
    } catch { /* non-fatal */ }

    switch (body.action) {
      case "install": {
        const { data, error } = await userClient.rpc("install_app", {
          p_org_id: body.organization_id,
          p_app_id: body.app_id,
        });
        if (error) {
          // Durable failure log: install_app's own attempt-row UPDATE is rolled
          // back together with the failed transaction, so we record the error
          // here in a fresh transaction the caller can later inspect.
          if (callerUserId) {
            try {
              await userClient.rpc("record_install_attempt_failure", {
                p_org_id: body.organization_id,
                p_user_id: callerUserId,
                p_requested_app_id: body.app_id,
                p_error_code: error.code ?? "UNKNOWN",
                p_error_message: error.message ?? "",
                p_plan_snapshot: null,
              });
            } catch (logErr) {
              console.error("record_install_attempt_failure failed", logErr);
            }
          }
          return json({ error: error.message, code: error.code }, 400);
        }
        return json({ success: true, installed: data });
      }

      case "uninstall": {
        const { data, error } = await userClient.rpc("uninstall_app", {
          p_org_id: body.organization_id,
          p_app_id: body.app_id,
        });
        if (error) return json({ error: error.message, code: error.code }, 400);
        return json({ success: true, removed: data });
      }

      case "start_trial": {
        const days = (body as StartTrialBody).days ?? 14;
        const { data, error } = await userClient.rpc("start_app_trial", {
          p_org_id: body.organization_id,
          p_app_id: body.app_id,
          p_days: days,
        });
        if (error) return json({ error: error.message, code: error.code }, 400);
        return json({ success: true, trial: data });
      }

      case "preview_install_impact": {
        const { data, error } = await userClient.rpc("preview_install_impact", {
          p_org_id: body.organization_id,
          p_app_id: body.app_id,
        });
        if (error) return json({ error: error.message, code: error.code }, 400);
        return json({ success: true, preview: data });
      }

      default:
        return json({ error: `Unknown action: ${(body as { action: string }).action}` }, 400);
    }
  } catch (err) {
    console.error("app-lifecycle error", err);
    return json({ error: (err as Error).message ?? "Internal error" }, 500);
  }
});
