/**
 * Shared helper: trigger an SMS event from any edge function.
 *
 * Usage from another edge function:
 *   import { triggerSmsEvent } from "../_shared/triggerSmsEvent.ts";
 *   await triggerSmsEvent(supabaseUrl, serviceKey, {
 *     organization_id, business_id, event_type: "payroll_processed",
 *     recipient_phone, template_variables: { ... },
 *   });
 *
 * The call is fire-and-forget from the caller's perspective: we await it for
 * a structured result, but every error path is swallowed and logged so the
 * caller's primary job (e.g. computing payroll) is never blocked by SMS.
 */

interface TriggerArgs {
  organization_id: string;
  business_id?: string | null;
  event_type: string;
  recipient_phone: string;
  template_variables?: Record<string, string>;
}

export async function triggerSmsEvent(
  supabaseUrl: string,
  serviceKey: string,
  args: TriggerArgs,
): Promise<{ success: boolean; reason?: string }> {
  if (!args.recipient_phone) return { success: false, reason: "no_phone" };
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        organization_id: args.organization_id,
        business_id: args.business_id ?? null,
        event_type: args.event_type,
        recipient_phone: args.recipient_phone,
        template_variables: args.template_variables ?? {},
      }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!body.success) {
      console.warn(`[triggerSmsEvent] ${args.event_type} skipped: ${body.code || body.error}`);
      return { success: false, reason: body.code || body.error };
    }
    return { success: true };
  } catch (e) {
    console.error(`[triggerSmsEvent] ${args.event_type} failed:`, e);
    return { success: false, reason: (e as Error).message };
  }
}
