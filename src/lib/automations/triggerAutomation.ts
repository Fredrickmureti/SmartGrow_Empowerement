import { supabase } from "@/integrations/supabase/client";

export type AutomationEventType =
  | "on_create"
  | "on_update"
  | "on_delete"
  | "field_change";

interface TriggerAutomationPayload {
  event_type: AutomationEventType;
  target_model: string;
  record_id: string;
  record_data?: Record<string, unknown>;
  old_data?: Record<string, unknown>;
  changed_fields?: string[];
  organization_id: string;
}

/**
 * Fire-and-forget call to the process-automation edge function.
 * This bridges CRUD events in the app to the automation engine.
 * Errors are logged but never thrown — automations must not block core workflows.
 */
export async function triggerAutomation(payload: TriggerAutomationPayload): Promise<void> {
  try {
    const { error } = await supabase.functions.invoke("process-automation", {
      body: payload,
    });

    if (error) {
      console.warn("[triggerAutomation] Edge function error:", error.message);
    }
  } catch (err) {
    // Never block the main CRUD operation
    console.warn("[triggerAutomation] Failed to invoke:", err);
  }
}

/**
 * Helper to compute which fields changed between old and new record data.
 */
export function getChangedFields(
  oldData: Record<string, unknown> | null | undefined,
  newData: Record<string, unknown> | null | undefined
): string[] {
  const safeOld = oldData ?? {};
  const safeNew = newData ?? {};
  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(safeOld), ...Object.keys(safeNew)]);
  for (const key of allKeys) {
    if (JSON.stringify(safeOld[key]) !== JSON.stringify(safeNew[key])) {
      changed.push(key);
    }
  }
  return changed;
}
