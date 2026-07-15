import { FunctionsHttpError } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

export interface InvitationEmailResult {
  id?: string | null;
  acceptUrl?: string | null;
}

export class InvitationEmailError extends Error {
  acceptUrl: string | null;

  constructor(message: string, acceptUrl: string | null = null) {
    super(message);
    this.name = "InvitationEmailError";
    this.acceptUrl = acceptUrl;
  }
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const details = typeof record.details === "string" ? record.details : null;
  const error = typeof record.error === "string" ? record.error : null;
  const message = typeof record.message === "string" ? record.message : null;
  return details || error || message;
}

function extractAcceptUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const acceptUrl = record.accept_url ?? record.acceptUrl;
  return typeof acceptUrl === "string" && acceptUrl.length > 0 ? acceptUrl : null;
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

async function readFunctionError(error: unknown): Promise<{ message: string; acceptUrl: string | null }> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.text();
      if (!body) return { message: error.message, acceptUrl: null };
      try {
        const payload = JSON.parse(body);
        return {
          message: extractErrorMessage(payload) || body,
          acceptUrl: extractAcceptUrl(payload),
        };
      } catch {
        return { message: body, acceptUrl: null };
      }
    } catch {
      return { message: error.message, acceptUrl: null };
    }
  }

  return { message: await describeInvitationEmailError(error), acceptUrl: extractAcceptUrl(error) };
}

export function buildInvitationAcceptUrl(token: string | null | undefined) {
  if (!token) return null;
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  if (!baseUrl) return `/accept-invitation?token=${encodeURIComponent(token)}`;
  const url = new URL("/accept-invitation", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export async function copyInvitationLink(acceptUrl: string | null | undefined) {
  if (!acceptUrl) throw new Error("No invitation link is available to copy.");
  await navigator.clipboard.writeText(acceptUrl);
}

export async function sendInvitationEmailOrThrow(invitationId: string | null | undefined): Promise<InvitationEmailResult> {
  if (!invitationId) {
    throw new Error("Invitation was saved, but no invitation id was returned.");
  }

  const { data, error } = await supabase.functions.invoke("send-invitation-email", {
    body: { invitationId },
  });

  if (error) {
    const details = await readFunctionError(error);
    throw new InvitationEmailError(details.message, details.acceptUrl);
  }

  const payload = data as { id?: string | null; accept_url?: string | null } | null;
  return { id: payload?.id ?? null, acceptUrl: payload?.accept_url ?? null };
}