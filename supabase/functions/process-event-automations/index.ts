/**
 * Process Event-Based Automations
 * 
 * Handles on_create, on_update, on_delete, and field_change triggers.
 * Called by database triggers via pg_net when records change.
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface EventPayload {
  trigger_type: "on_create" | "on_update" | "on_delete" | "field_change";
  target_model: string;
  record_id: string;
  organization_id: string;
  old_record?: Record<string, unknown>;
  new_record?: Record<string, unknown>;
  changed_fields?: string[];
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ─── Caller authentication ───
    // Accept either: (a) service-role token (DB triggers via pg_net), or
    // (b) an authenticated user JWT whose org membership we verify.
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const isServiceRole = token === supabaseServiceKey;

    const payload: EventPayload = await req.json();
    const { trigger_type, target_model, record_id, organization_id, old_record, new_record, changed_fields } = payload;

    if (!trigger_type || !target_model || !organization_id) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!isServiceRole) {
      const userClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: membership } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("user_id", userData.user.id)
        .eq("organization_id", organization_id)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();
      if (!membership) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    console.log(`[event-automations] ${trigger_type} on ${target_model} record ${record_id} in org ${organization_id}`);

    // Fetch matching automations
    const triggerTypes = [trigger_type];
    if (trigger_type === "on_update" && changed_fields && changed_fields.length > 0) {
      triggerTypes.push("field_change");
    }

    const { data: automations, error: fetchError } = await supabase
      .from("automated_actions")
      .select(`*, steps:automated_action_steps(*)`)
      .eq("is_active", true)
      .eq("target_model", target_model)
      .eq("organization_id", organization_id)
      .in("trigger_type", triggerTypes)
      .eq("is_circuit_broken", false);

    if (fetchError) {
      console.error("[event-automations] Fetch error:", fetchError);
      throw fetchError;
    }

    if (!automations || automations.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Entitlement check (once per org)
    const { checkSubscriptionActive } = await import("../_shared/entitlementCheck.ts");
    const subResult = await checkSubscriptionActive(supabase, organization_id);
    if (!subResult.allowed) {
      console.log(`[event-automations] Org ${organization_id} subscription inactive: ${subResult.reason}`);
      return new Response(JSON.stringify({ processed: 0, reason: subResult.reason }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{ id: string; name: string; status: string; error?: string }> = [];

    for (const automation of automations) {
      try {
        // For field_change triggers, check if the watched fields were actually changed
        if (automation.trigger_type === "field_change") {
          const watchedFields = automation.watched_fields || [];
          if (watchedFields.length > 0 && changed_fields) {
            const hasMatch = watchedFields.some((f: string) => changed_fields.includes(f));
            if (!hasMatch) {
              continue; // Skip — none of the watched fields changed
            }
          }
        }

        // Rate limit: max 100 executions per hour per automation
        const hourBucket = new Date().toISOString().slice(0, 13);
        const { data: tracker } = await supabase
          .from("automation_execution_tracker")
          .select("execution_count")
          .eq("automation_id", automation.id)
          .eq("hour_bucket", hourBucket)
          .single();

        if (tracker && tracker.execution_count >= 100) {
          console.warn(`[event-automations] Rate limit hit for ${automation.id}`);
          results.push({ id: automation.id, name: automation.name, status: "rate_limited" });
          continue;
        }

        // Upsert tracker
        const { error: rpcError } = await supabase.rpc("increment_automation_tracker", {
          _automation_id: automation.id,
          _organization_id: organization_id,
          _hour_bucket: hourBucket,
        });
        if (rpcError) {
          // If RPC doesn't exist, do a manual upsert
          await supabase
            .from("automation_execution_tracker")
            .upsert({
              automation_id: automation.id,
              organization_id,
              hour_bucket: hourBucket,
              execution_count: 1,
            }, { onConflict: "automation_id,hour_bucket" });
        }

        // Create execution log
        const { data: logEntry } = await supabase
          .from("automated_action_logs")
          .insert({
            action_id: automation.id,
            organization_id,
            trigger_type,
            target_model,
            target_record_id: record_id,
            status: "running",
            started_at: new Date().toISOString(),
          })
          .select()
          .single();

        // Execute steps
        const sortedSteps = (automation.steps || []).sort(
          (a: any, b: any) => a.step_order - b.step_order
        );
        let stepsExecuted = 0;

        for (const step of sortedSteps) {
          try {
            await executeStep(supabase, step, automation, record_id, new_record, old_record);
            stepsExecuted++;
          } catch (stepError) {
            console.error(`[event-automations] Step ${step.step_name || step.action_type} failed:`, stepError);
            if (step.on_error === "stop") break;
          }
        }

        // Update log
        if (logEntry) {
          await supabase
            .from("automated_action_logs")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
              steps_executed: sortedSteps.map((s: any) => ({
                step_name: s.step_name,
                action_type: s.action_type,
              })),
            })
            .eq("id", logEntry.id);
        }

        // Update last_run_at
        await supabase
          .from("automated_actions")
          .update({ last_run_at: new Date().toISOString() })
          .eq("id", automation.id);

        results.push({ id: automation.id, name: automation.name, status: "completed" });
      } catch (error) {
        console.error(`[event-automations] Automation ${automation.id} failed:`, error);
        results.push({
          id: automation.id,
          name: automation.name,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    console.log(`[event-automations] Processed ${results.length} automations`);

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[event-automations] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function executeStep(
  supabase: any,
  step: any,
  automation: any,
  recordId: string,
  newRecord?: Record<string, unknown>,
  oldRecord?: Record<string, unknown>,
) {
  const config = step.action_config || {};

  // Template string replacement: {{field_name}} -> record value
  function resolveTemplate(template: string): string {
    if (!template || !newRecord) return template || "";
    return template.replace(/\{\{(\w+)\}\}/g, (_: string, field: string) => {
      return String(newRecord[field] ?? oldRecord?.[field] ?? "");
    });
  }

  switch (step.action_type) {
    case "send_notification":
      await supabase.from("notifications").insert({
        organization_id: automation.organization_id,
        type: "automation",
        title: resolveTemplate(config.title as string || "Automated Notification"),
        message: resolveTemplate(config.message as string || ""),
        priority: config.priority || "medium",
      });
      break;

    case "send_email":
      await supabase.functions.invoke("send-email", {
        body: {
          to: resolveTemplate(config.to as string),
          subject: resolveTemplate(config.subject as string),
          body: resolveTemplate(config.body as string),
          template: config.template,
          // Tenant context so send-email resolves the From-line to the
          // business identity instead of the platform default (ADR 0023).
          category: "system_notification",
          organization_id: automation.organization_id,
          business_id: automation.business_id ?? null,
          template_key: "automation:event_email",
        },
      });
      break;

    case "update_field":
    case "update_record":
      if (config.field && config.value !== undefined) {
        const updateData: Record<string, unknown> = {};
        updateData[config.field as string] = config.value;
        await supabase
          .from(automation.target_model === "crm_lead" ? "crm_leads" : `${automation.target_model}s`)
          .update(updateData)
          .eq("id", recordId);
      }
      break;

    case "webhook_call":
      if (config.url) {
        const webhookBody = config.body
          ? JSON.parse(resolveTemplate(JSON.stringify(config.body)))
          : { trigger_type: automation.trigger_type, target_model: automation.target_model, record_id: recordId, record: newRecord };
        await fetch(config.url as string, {
          method: (config.method as string) || "POST",
          headers: { "Content-Type": "application/json", ...(config.headers as Record<string, string> || {}) },
          body: JSON.stringify(webhookBody),
        });
      }
      break;

    default:
      console.warn(`[event-automations] Unknown action type: ${step.action_type}`);
  }
}
