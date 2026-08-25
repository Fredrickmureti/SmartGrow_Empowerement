import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface AutomationPayload {
  event_type: string;
  target_model: string;
  record_id?: string;
  record_data?: Record<string, unknown>;
  old_data?: Record<string, unknown>;
  changed_fields?: string[];
  organization_id: string;
}

interface ActionStep {
  id: string;
  action_type: string;
  action_config: Record<string, unknown>;
  step_order: number;
  condition?: Condition | null;
  on_error?: string;
}

interface StepResult {
  step_id: string;
  action_type: string;
  success: boolean;
  result?: unknown;
  error?: string;
  retries?: number;
}

// ============= Condition Evaluator =============
type ComparisonOperator =
  | "=" | "!=" | ">" | "<" | ">=" | "<="
  | "in" | "not_in" | "contains" | "not_contains"
  | "starts_with" | "ends_with" | "is_set" | "is_not_set"
  | "changed" | "changed_to" | "changed_from";

interface SimpleCondition {
  field: string;
  operator: ComparisonOperator;
  value?: unknown;
}

interface ConditionGroup {
  logic: "and" | "or";
  conditions: Array<SimpleCondition | ConditionGroup>;
}

type Condition = SimpleCondition | ConditionGroup;

interface EvaluationContext {
  record: Record<string, unknown>;
  oldRecord?: Record<string, unknown>;
  changedFields?: string[];
}

function getFieldValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, arrayName, indexStr] = arrayMatch;
      current = (current as Record<string, unknown>)[arrayName];
      if (Array.isArray(current)) current = current[parseInt(indexStr, 10)];
      else return undefined;
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function compareNumeric(a: unknown, b: unknown): number {
  const numA = typeof a === "number" ? a : parseFloat(String(a));
  const numB = typeof b === "number" ? b : parseFloat(String(b));
  if (isNaN(numA) || isNaN(numB)) return String(a).localeCompare(String(b));
  return numA - numB;
}

function evaluateSimpleCondition(condition: SimpleCondition, context: EvaluationContext): boolean {
  const { field, operator, value } = condition;
  const fieldValue = getFieldValue(context.record, field);
  const oldFieldValue = context.oldRecord ? getFieldValue(context.oldRecord, field) : undefined;

  switch (operator) {
    case "=": return isEqual(fieldValue, value);
    case "!=": return !isEqual(fieldValue, value);
    case ">": return compareNumeric(fieldValue, value) > 0;
    case "<": return compareNumeric(fieldValue, value) < 0;
    case ">=": return compareNumeric(fieldValue, value) >= 0;
    case "<=": return compareNumeric(fieldValue, value) <= 0;
    case "in": return Array.isArray(value) && value.some((v) => isEqual(fieldValue, v));
    case "not_in": return !Array.isArray(value) || !value.some((v) => isEqual(fieldValue, v));
    case "contains":
      return typeof fieldValue === "string" && fieldValue.toLowerCase().includes(String(value).toLowerCase());
    case "not_contains":
      return typeof fieldValue !== "string" || !fieldValue.toLowerCase().includes(String(value).toLowerCase());
    case "starts_with":
      return typeof fieldValue === "string" && fieldValue.toLowerCase().startsWith(String(value).toLowerCase());
    case "ends_with":
      return typeof fieldValue === "string" && fieldValue.toLowerCase().endsWith(String(value).toLowerCase());
    case "is_set":
      return fieldValue !== null && fieldValue !== undefined && fieldValue !== "";
    case "is_not_set":
      return fieldValue === null || fieldValue === undefined || fieldValue === "";
    case "changed":
      return context.changedFields?.includes(field) || !isEqual(fieldValue, oldFieldValue);
    case "changed_to":
      return (!isEqual(fieldValue, oldFieldValue)) && isEqual(fieldValue, value);
    case "changed_from":
      return (!isEqual(fieldValue, oldFieldValue)) && isEqual(oldFieldValue, value);
    default:
      return false;
  }
}

function isConditionGroup(condition: Condition): condition is ConditionGroup {
  return "logic" in condition && "conditions" in condition;
}

function evaluateCondition(condition: Condition | null | undefined, context: EvaluationContext): boolean {
  if (!condition) return true;
  if (isConditionGroup(condition)) {
    const { logic, conditions } = condition;
    if (conditions.length === 0) return true;
    return logic === "and"
      ? conditions.every((c) => evaluateCondition(c, context))
      : conditions.some((c) => evaluateCondition(c, context));
  }
  return evaluateSimpleCondition(condition, context);
}

// ============= Variable Interpolation =============
function interpolate(template: string, context: Record<string, unknown>): string {
  if (!template || typeof template !== "string") return template;
  return template.replace(/\{\{([^{}|]+)(?:\|([^{}]+))?\}\}/g, (match, path, filter) => {
    const value = getFieldValue(context, path.trim());
    if (value === null || value === undefined) return "";
    let result = String(value);
    if (filter) {
      const filters = filter.split("|");
      for (const f of filters) {
        const [filterName, ...args] = f.trim().split(":");
        switch (filterName) {
          case "upper": result = result.toUpperCase(); break;
          case "lower": result = result.toLowerCase(); break;
          case "default": result = result || args[0] || ""; break;
          case "truncate":
            const len = parseInt(args[0] || "50", 10);
            result = result.length > len ? result.slice(0, len) + "..." : result;
            break;
        }
      }
    }
    return result;
  });
}

function interpolateObject<T>(obj: T, context: Record<string, unknown>): T {
  if (typeof obj === "string") return interpolate(obj, context) as T;
  if (Array.isArray(obj)) return obj.map((item) => interpolateObject(item, context)) as T;
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateObject(value, context);
    }
    return result as T;
  }
  return obj;
}

// ============= Retry with Exponential Backoff =============
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries: number; baseDelayMs: number; onError?: string }
): Promise<{ result: T | null; error?: string; retries: number }> {
  let lastError: string | undefined;
  let retries = 0;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const result = await fn();
      return { result, retries: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      retries = attempt;
      
      if (options.onError === "stop") {
        break;
      }
      
      if (attempt < options.maxRetries && options.onError === "retry") {
        const delay = options.baseDelayMs * Math.pow(2, attempt);
        console.log(`[process-automation] Retry ${attempt + 1}/${options.maxRetries} after ${delay}ms`);
        await sleep(delay);
      } else if (options.onError !== "retry") {
        break;
      }
    }
  }

  return { result: null, error: lastError, retries };
}

// ============= Step Executors =============
async function executeStep(
  supabase: SupabaseClient,
  step: ActionStep,
  context: { record_data?: Record<string, unknown>; old_data?: Record<string, unknown>; organization_id: string; record_id?: string; changedFields?: string[] }
): Promise<StepResult> {
  const { action_type, action_config, id, on_error } = step;
  
  // Check step condition
  if (step.condition) {
    const conditionContext: EvaluationContext = {
      record: context.record_data || {},
      oldRecord: context.old_data,
      changedFields: context.changedFields,
    };
    if (!evaluateCondition(step.condition, conditionContext)) {
      console.log(`[process-automation] Step ${id} skipped: condition not met`);
      return { step_id: id, action_type, success: true, result: { skipped: true, reason: "condition_not_met" } };
    }
  }

  // Interpolation context
  const interpolationContext: Record<string, unknown> = {
    ...context.record_data,
    record: context.record_data,
    old: context.old_data,
    organization_id: context.organization_id,
    record_id: context.record_id,
    now: new Date().toISOString(),
  };

  // Interpolate action config
  const config = interpolateObject(action_config, interpolationContext);
  
  const executeAction = async (): Promise<unknown> => {
    switch (action_type) {
      case "update_record": {
        const { table, values, record_id_field } = config as { 
          table: string; values: Record<string, unknown>; record_id_field?: string;
        };
        const targetId = record_id_field ? context.record_data?.[record_id_field] : context.record_id;
        if (!targetId) throw new Error("No record ID for update");
        const { error } = await supabase.from(table).update(values).eq("id", targetId);
        if (error) throw error;
        return { updated: targetId };
      }

      case "create_record": {
        const { table, values } = config as { table: string; values: Record<string, unknown> };
        const insertData = { ...values, organization_id: context.organization_id };
        const { data, error } = await supabase.from(table).insert(insertData).select().single();
        if (error) throw error;
        return { created_id: data?.id };
      }

      case "send_notification": {
        const { title, message, user_id, type = "info", priority = "medium" } = config as {
          title: string; message: string; user_id?: string; type?: string; priority?: string;
        };
        const { error } = await supabase.from("notifications").insert({
          organization_id: context.organization_id,
          user_id: user_id || null,
          title,
          message,
          type,
          priority,
          is_read: false,
        });
        if (error) throw error;
        return { notification_sent: true };
      }

      case "create_activity": {
        const { summary, activity_type, lead_id, due_date, assigned_to } = config as {
          summary: string; activity_type?: string; lead_id?: string; due_date?: string; assigned_to?: string;
        };
        const targetLeadId = lead_id || context.record_data?.id || context.record_data?.lead_id;
        if (!targetLeadId) throw new Error("No lead ID for activity");
        // crm_activities is business/branch scoped; derive the scope from the lead itself.
        const { data: leadScope, error: leadScopeError } = await supabase
          .from("crm_leads")
          .select("id, organization_id, business_id, branch_id")
          .eq("id", targetLeadId)
          .maybeSingle();
        if (leadScopeError) throw leadScopeError;
        if (!leadScope) throw new Error(`Lead ${targetLeadId} not found; cannot create activity`);
        if (leadScope.organization_id !== context.organization_id) {
          throw new Error("Lead belongs to a different organization; refusing to create activity");
        }
        const { error } = await supabase.from("crm_activities").insert({
          organization_id: leadScope.organization_id,
          business_id: leadScope.business_id,
          branch_id: leadScope.branch_id,
          lead_id: targetLeadId,
          summary,
          activity_type: activity_type || "task",
          due_date: due_date || new Date().toISOString().split("T")[0],
          assigned_to: assigned_to || null,
        });
        if (error) throw error;
        return { activity_created: true };
      }

      case "webhook_call": {
        const { url, method = "POST", headers = {}, body } = config as {
          url: string; method?: string; headers?: Record<string, string>; body?: Record<string, unknown>;
        };
        const response = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body || context.record_data),
        });
        if (!response.ok) throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
        return { status: response.status };
      }

      case "send_email": {
        const { to, subject, body } = config as {
          to: string; subject: string; body: string; template_id?: string;
        };

        if (!to) throw new Error("Email 'to' address is required");

        // Route through supabase.functions.invoke (NOT raw fetch) so the
        // shared send-email transport can resolve the tenant From-line via
        // resolveSenderIdentity (ADR 0023).
        const { error: emailErr } = await supabase.functions.invoke("send-email", {
          body: {
            to,
            subject: subject || "Automated Notification",
            html: body || "",
            category: "system_notification",
            organization_id: context.organization_id,
            template_key: "automation:action_email",
          },
        });
        if (emailErr) throw new Error(`Email send failed: ${emailErr.message ?? String(emailErr)}`);
        return { email_sent: to };
      }

      case "run_code": {
        const { function_name, payload } = config as {
          function_name: string; payload?: Record<string, unknown>;
        };
        const { error } = await supabase.functions.invoke(function_name, {
          body: payload || context.record_data,
        });
        if (error) throw error;
        return { function_invoked: function_name };
      }

      case "add_tag": {
        const { tag } = config as { tag: string };
        const currentTags = (context.record_data?.tags as string[]) || [];
        if (!currentTags.includes(tag)) {
          const { error } = await supabase
            .from(context.record_data?.["__table"] as string || "crm_leads")
            .update({ tags: [...currentTags, tag] })
            .eq("id", context.record_id);
          if (error) throw error;
        }
        return { tag_added: tag };
      }

      default:
        console.warn(`[process-automation] Unknown action type: ${action_type}`);
        throw new Error(`Unknown action type: ${action_type}`);
    }
  };

  // Execute with retry logic if configured
  const shouldRetry = on_error === "retry";
  const maxRetries = shouldRetry ? 3 : 0;
  const baseDelayMs = 1000;

  const { result, error, retries } = await withRetry(executeAction, {
    maxRetries,
    baseDelayMs,
    onError: on_error,
  });

  if (error) {
    console.error(`[process-automation] Step ${id} failed:`, error);
    return { step_id: id, action_type, success: false, error, retries };
  }

  return { step_id: id, action_type, success: true, result, retries };
}

serve(async (req) => {
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

    const payload: AutomationPayload = await req.json();
    const { event_type, target_model, record_id, record_data, old_data, changed_fields, organization_id } = payload;

    if (!isServiceRole) {
      // User token path — verify user exists and belongs to organization_id
      const userClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!organization_id) {
        return new Response(JSON.stringify({ error: "organization_id required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        return new Response(JSON.stringify({ error: "Forbidden: not a member of organization" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    console.log("[process-automation] Processing:", { event_type, target_model, record_id, organization_id });

    // ─── Subscription active check ───
    if (organization_id) {
      const { checkSubscriptionActive, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
      const subResult = await checkSubscriptionActive(supabase, organization_id);
      if (!subResult.allowed) return entitlementDeniedResponse(subResult, corsHeaders);
    }

    // Find matching active automations
    const { data: automations, error: automationsError } = await supabase
      .from("automated_actions")
      .select("*")
      .eq("organization_id", organization_id)
      .eq("target_model", target_model)
      .eq("trigger_type", event_type)
      .eq("is_active", true);

    if (automationsError) throw automationsError;

    if (!automations || automations.length === 0) {
      return new Response(JSON.stringify({ message: "No matching automations found" }), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const results: Array<{ automation_id: string; success: boolean; steps_executed: number; step_results: StepResult[] }> = [];

    for (const automation of automations) {
      // ─── Circuit Breaker Check ───
      try {
        const { data: cbAllowed } = await supabase.rpc("check_automation_circuit_breaker", {
          _automation_id: automation.id,
          _organization_id: organization_id,
          _max_executions_per_hour: 50,
        });
        if (cbAllowed === false) {
          console.warn(`[process-automation] Circuit breaker tripped for automation ${automation.id}`);
          results.push({ automation_id: automation.id, success: false, steps_executed: 0, step_results: [] });
          continue;
        }
      } catch (cbErr) {
        console.warn(`[process-automation] Circuit breaker check failed:`, cbErr);
        // Continue execution if circuit breaker check fails — don't block
      }

      // Check filter_domain conditions
      if (automation.filter_domain && Array.isArray(automation.filter_domain) && automation.filter_domain.length > 0) {
        const filterContext: EvaluationContext = {
          record: record_data || {},
          oldRecord: old_data,
          changedFields: changed_fields,
        };
        const filterConditions: SimpleCondition[] = automation.filter_domain.map(
          ([field, op, val]: [string, string, unknown]) => ({ field, operator: op as ComparisonOperator, value: val })
        );
        const filterGroup: ConditionGroup = { logic: "and", conditions: filterConditions };
        if (!evaluateCondition(filterGroup, filterContext)) {
          console.log(`[process-automation] Automation ${automation.id} skipped: filter_domain not met`);
          continue;
        }
      }

      // Check field_change trigger
      if (event_type === "field_change" && automation.watched_fields) {
        const watchedFields = automation.watched_fields as string[];
        const hasRelevantChange = changed_fields?.some((f) => watchedFields.includes(f));
        if (!hasRelevantChange) continue;
      }

      // Get steps ordered
      const { data: steps } = await supabase
        .from("automated_action_steps")
        .select("*")
        .eq("action_id", automation.id)
        .order("step_order", { ascending: true });

      const stepResults: StepResult[] = [];
      let hasFailure = false;
      const startedAt = new Date().toISOString();

      // Execute each step in order
      for (const step of (steps || []) as ActionStep[]) {
        const result = await executeStep(supabase, step, { 
          record_data, 
          old_data,
          organization_id, 
          record_id,
          changedFields: changed_fields,
        });
        stepResults.push(result);

        if (!result.success) {
          hasFailure = true;
          if (step.on_error === "stop") break;
        }
      }

      const completedAt = new Date().toISOString();

      // Log execution
      await supabase.from("automated_action_logs").insert({
        action_id: automation.id,
        organization_id,
        trigger_type: event_type,
        target_model,
        target_record_id: record_id,
        status: hasFailure ? "partial" : "completed",
        started_at: startedAt,
        completed_at: completedAt,
        steps_executed: stepResults,
        error_message: hasFailure ? stepResults.find(r => !r.success)?.error : null,
      });

      // Update last_run_at
      await supabase
        .from("automated_actions")
        .update({ last_run_at: completedAt })
        .eq("id", automation.id);

      results.push({ 
        automation_id: automation.id, 
        success: !hasFailure, 
        steps_executed: stepResults.length,
        step_results: stepResults,
      });
    }

    return new Response(JSON.stringify({ success: true, results }), { 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  } catch (error) {
    console.error("[process-automation] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), 
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
