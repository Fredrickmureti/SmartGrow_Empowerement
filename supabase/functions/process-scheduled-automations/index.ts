import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface AutomatedAction {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  description: string | null;
  trigger_type: string;
  target_model: string;
  filter_domain: unknown;
  trigger_conditions: unknown;
  schedule_config: {
    type?: string;
    interval_hours?: number;
    time_of_day?: string;
    day_of_week?: number;
    day_of_month?: number;
  } | null;
  is_active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  steps: Array<{
    id: string;
    step_order: number;
    step_name: string | null;
    action_type: string;
    action_config: Record<string, unknown>;
    condition: unknown;
    on_error: string | null;
  }>;
}

function calculateNextRunAt(scheduleConfig: AutomatedAction["schedule_config"]): string {
  const now = new Date();
  
  if (!scheduleConfig) {
    // Default: run again in 24 hours
    now.setHours(now.getHours() + 24);
    return now.toISOString();
  }

  switch (scheduleConfig.type) {
    case "hourly":
      now.setHours(now.getHours() + (scheduleConfig.interval_hours || 1));
      break;
    case "daily":
      now.setDate(now.getDate() + 1);
      if (scheduleConfig.time_of_day) {
        const [hours, minutes] = scheduleConfig.time_of_day.split(":").map(Number);
        now.setHours(hours, minutes, 0, 0);
      }
      break;
    case "weekly":
      now.setDate(now.getDate() + 7);
      break;
    case "monthly":
      now.setMonth(now.getMonth() + 1);
      if (scheduleConfig.day_of_month) {
        now.setDate(Math.min(scheduleConfig.day_of_month, 28)); // Safe for all months
      }
      break;
    default:
      now.setHours(now.getHours() + 24);
  }

  return now.toISOString();
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date().toISOString();
    console.log(`[process-scheduled-automations] Starting at: ${now}`);

    // ── SMS outbox + retry flush ──
    try {
      const { flushSmsOutbox } = await import("../_shared/flushSmsOutbox.ts");
      const smsResult = await flushSmsOutbox(supabaseUrl, supabaseServiceKey);
      console.log(
        `[process-scheduled-automations] SMS flush — outbox ${smsResult.outboxSent}/${smsResult.outboxProcessed}, retries ${smsResult.retrySent}/${smsResult.retryProcessed}`,
      );
    } catch (e) {
      console.error("[process-scheduled-automations] SMS flush failed:", e);
    }

    // ── Email outbox flush ──
    try {
      const { flushEmailOutbox } = await import("../_shared/flushEmailOutbox.ts");
      const emailResult = await flushEmailOutbox(supabaseUrl, supabaseServiceKey);
      console.log(
        `[process-scheduled-automations] Email flush — outbox ${emailResult.outboxSent}/${emailResult.outboxProcessed}`,
      );
    } catch (e) {
      console.error("[process-scheduled-automations] Email flush failed:", e);
    }

    // ── Customer statement send-queue flush ──
    // Bulk statement delivery is durable and retried here, never in a browser
    // loop; the queue's idempotency key prevents duplicate sends.
    try {
      const { flushStatementSendOutbox } = await import(
        "../_shared/flushStatementSendOutbox.ts"
      );
      const stmtResult = await flushStatementSendOutbox(supabaseUrl, supabaseServiceKey);
      if (stmtResult.processed > 0) {
        console.log(
          `[process-scheduled-automations] Statement sends — ${stmtResult.sent}/${stmtResult.processed} sent, ${stmtResult.failed} failed`,
        );
      }
    } catch (e) {
      console.error("[process-scheduled-automations] Statement send flush failed:", e);
    }

    // ── Vendor statement send-queue flush ──
    // AP delivery is durable on exactly the same terms as AR: the queue owns
    // idempotency and retries, so no browser loop ever emails suppliers.
    try {
      const { flushVendorStatementSendOutbox } = await import(
        "../_shared/flushVendorStatementSendOutbox.ts"
      );
      const vendorResult = await flushVendorStatementSendOutbox(supabaseUrl, supabaseServiceKey);
      if (vendorResult.processed > 0) {
        console.log(
          `[process-scheduled-automations] Vendor statement sends — ${vendorResult.sent}/${vendorResult.processed} sent, ${vendorResult.failed} failed`,
        );
      }
    } catch (e) {
      console.error("[process-scheduled-automations] Vendor statement send flush failed:", e);
    }




    // Fetch all due scheduled automations
    const { data: automations, error: fetchError } = await supabase
      .from("automated_actions")
      .select(`
        *,
        steps:automated_action_steps(*)
      `)
      .eq("is_active", true)
      .eq("trigger_type", "time_based")
      .lte("next_run_at", now);

    if (fetchError) {
      console.error("[process-scheduled-automations] Fetch error:", fetchError);
      throw fetchError;
    }

    console.log(`[process-scheduled-automations] Found ${automations?.length || 0} automations to process`);

    const results: Array<{ id: string; name: string; status: string; stepsExecuted?: number; error?: string }> = [];

    for (const automation of (automations || []) as AutomatedAction[]) {
      const startTime = Date.now();
      let stepsExecuted = 0;

      try {
        // ─── Subscription active check per automation ───
        const { checkSubscriptionActive } = await import("../_shared/entitlementCheck.ts");
        const subResult = await checkSubscriptionActive(supabase, automation.organization_id);
        if (!subResult.allowed) {
          console.log(`[process-scheduled-automations] Skipping automation ${automation.id}: ${subResult.reason}`);
          results.push({ id: automation.id, name: automation.name, status: "skipped", error: subResult.reason });
          // Still update next_run_at so it doesn't keep retrying
          await supabase.from("automated_actions").update({
            next_run_at: calculateNextRunAt(automation.schedule_config),
            last_run_at: new Date().toISOString(),
          }).eq("id", automation.id);
          continue;
        }

        console.log(`[process-scheduled-automations] Processing automation: ${automation.name} (${automation.id})`);

        // Create execution log
        const { data: logEntry, error: logError } = await supabase
          .from("automated_action_logs")
          .insert({
            action_id: automation.id,
            organization_id: automation.organization_id,
            trigger_type: automation.trigger_type,
            target_model: automation.target_model,
            status: "running",
            started_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (logError) {
          console.error(`[process-scheduled-automations] Log creation error:`, logError);
        }

        // Sort steps by order
        const sortedSteps = (automation.steps || []).sort((a, b) => a.step_order - b.step_order);

        for (const step of sortedSteps) {
          try {
            console.log(`[process-scheduled-automations] Executing step: ${step.step_name || step.action_type}`);

            switch (step.action_type) {
              case "send_notification":
                await supabase.from("notifications").insert({
                  organization_id: automation.organization_id,
                  type: "automation",
                  title: (step.action_config.title as string) || "Automated Notification",
                  message: (step.action_config.message as string) || "",
                  priority: (step.action_config.priority as string) || "medium",
                });
                break;

              case "send_email":
                // Invoke email edge function. Tenant context lets send-email
                // resolve the From-line to the business identity instead of
                // the platform default (ADR 0023).
                const emailResult = await supabase.functions.invoke("send-email", {
                  body: {
                    to: step.action_config.to,
                    subject: step.action_config.subject,
                    body: step.action_config.body,
                    template: step.action_config.template,
                    category: "system_notification",
                    organization_id: automation.organization_id,
                    business_id: automation.business_id ?? null,
                    template_key: "automation:scheduled_email",
                  },
                });
                if (emailResult.error) {
                  console.warn(`[process-scheduled-automations] Email step warning:`, emailResult.error);
                }
                break;

              case "update_field":
                // Generic field update on target model
                if (step.action_config.field && step.action_config.value !== undefined) {
                  const updateData: Record<string, unknown> = {};
                  updateData[step.action_config.field as string] = step.action_config.value;
                  
                  let query = supabase
                    .from(automation.target_model)
                    .update(updateData)
                    .eq("organization_id", automation.organization_id);

                  if (step.action_config.filter) {
                    // Apply additional filters if specified
                    const filter = step.action_config.filter as Record<string, unknown>;
                    for (const [key, value] of Object.entries(filter)) {
                      query = query.eq(key, value);
                    }
                  }

                  await query;
                }
                break;

              case "create_record":
                if (step.action_config.table && step.action_config.data) {
                  const recordData = {
                    ...(step.action_config.data as Record<string, unknown>),
                    organization_id: automation.organization_id,
                  };
                  await supabase.from(step.action_config.table as string).insert(recordData);
                }
                break;

              case "call_webhook":
                if (step.action_config.url) {
                  try {
                    await fetch(step.action_config.url as string, {
                      method: (step.action_config.method as string) || "POST",
                      headers: {
                        "Content-Type": "application/json",
                        ...(step.action_config.headers as Record<string, string> || {}),
                      },
                      body: JSON.stringify(step.action_config.body || {}),
                    });
                  } catch (webhookError) {
                    console.warn(`[process-scheduled-automations] Webhook error:`, webhookError);
                    if (step.on_error === "stop") throw webhookError;
                  }
                }
                break;

              case "run_function":
                // Call another edge function
                if (step.action_config.function_name) {
                  await supabase.functions.invoke(step.action_config.function_name as string, {
                    body: step.action_config.function_body || {},
                  });
                }
                break;

              default:
                console.log(`[process-scheduled-automations] Unknown action type: ${step.action_type}`);
            }

            stepsExecuted++;
          } catch (stepError) {
            console.error(`[process-scheduled-automations] Step error:`, stepError);
            if (step.on_error === "stop") {
              throw stepError;
            }
            // Continue to next step if on_error is not "stop"
          }
        }

        // Calculate next run time
        const nextRunAt = calculateNextRunAt(automation.schedule_config);

        // Update automation with last/next run times
        await supabase
          .from("automated_actions")
          .update({
            last_run_at: new Date().toISOString(),
            next_run_at: nextRunAt,
          })
          .eq("id", automation.id);

        // Update log entry
        if (logEntry) {
          await supabase
            .from("automated_action_logs")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
              steps_executed: sortedSteps.map((s) => ({
                step_name: s.step_name,
                action_type: s.action_type,
                executed: true,
              })),
            })
            .eq("id", logEntry.id);
        }

        console.log(`[process-scheduled-automations] Completed ${automation.name} in ${Date.now() - startTime}ms`);
        results.push({ id: automation.id, name: automation.name, status: "success", stepsExecuted });
      } catch (error) {
        console.error(`[process-scheduled-automations] Automation error:`, error);
        
        // Update log entry with error
        await supabase
          .from("automated_action_logs")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: String(error),
          })
          .match({ action_id: automation.id, status: "running" });

        // Still calculate next run even on failure
        const nextRunAt = calculateNextRunAt(automation.schedule_config);
        await supabase
          .from("automated_actions")
          .update({
            last_run_at: new Date().toISOString(),
            next_run_at: nextRunAt,
          })
          .eq("id", automation.id);

        results.push({ id: automation.id, name: automation.name, status: "error", error: String(error), stepsExecuted });
      }
    }

    console.log(`[process-scheduled-automations] Completed. Processed ${results.length} automations`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: results.length,
        results,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("[process-scheduled-automations] Fatal error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});
