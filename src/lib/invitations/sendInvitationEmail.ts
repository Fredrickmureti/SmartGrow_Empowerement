import { FunctionsHttpError } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const details = typeof record.details === "string" ? record.details : null;
  const error = typeof record.error === "string" ? record.error : null;
  const message = typeof record.message === "string" ? record.message : null;
  return details || error || message;
}

export async function describeInvitationEmailError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.text();
      if (!body) return error.message;
      try {
        return extractErrorMessage(JSON.parse(body)) || body;
      } catch {
        return body;
      }
    } catch {
      return error.message;
    }
  }

  if (error instanceof Error) return error.message;
  const extracted = extractErrorMessage(error);
  if (extracted) return extracted;
  return "unknown_error";
}

export async function sendInvitationEmailOrThrow(invitationId: string | null | undefined) {
  if (!invitationId) {
    throw new Error("Invitation was saved, but no invitation id was returned.");
  }

  const { error } = await supabase.functions.invoke("send-invitation-email", {
    body: { invitationId },
  });

  if (error) {
    throw new Error(await describeInvitationEmailError(error));
  }
}