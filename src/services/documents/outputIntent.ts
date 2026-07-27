/**
 * Wave 4 — Output Intent client shim.
 *
 * Frontend/service callers should use `resolveOutputIntent` to obtain the
 * routing plan for a rendered document. The plan enumerates one or more
 * targets: each target is a (medium, disposition, hardware_role) tuple that
 * downstream layers (rendering engine, print queue, email pipeline) consume.
 *
 * This module MUST remain routing-only. It never renders bytes and it never
 * talks to hardware directly.
 */
import { supabase } from "@/integrations/supabase/client";

export type OutputMedium = "pdf" | "escpos" | "zpl" | "html";
export type OutputDisposition =
  | "print"
  | "email"
  | "download"
  | "archive"
  | "fiscal"
  | "webhook";

export interface OutputIntentTarget {
  id: string;
  medium: OutputMedium;
  disposition: OutputDisposition;
  hardware_role: string | null;
  template_code: string | null;
  copies: number;
  priority: number;
  params: Record<string, unknown>;
}

export interface ResolvedOutputIntent {
  resolved: true;
  intent_id: string;
  intent_name: string;
  scope: "system" | "tenant" | "organization" | "branch";
  scenario: string;
  targets: OutputIntentTarget[];
}

export interface UnresolvedOutputIntent {
  resolved: false;
  reason: string;
}

export type OutputIntentResult =
  | ResolvedOutputIntent
  | UnresolvedOutputIntent;

export interface ResolveOutputIntentInput {
  documentKind: string;
  organizationId: string;
  branchId?: string | null;
  scenario?: string;
  documentId?: string | null;
  triggeredSource?: "business_event" | "manual" | "reprint" | "api";
}

export async function resolveOutputIntent(
  input: ResolveOutputIntentInput,
): Promise<OutputIntentResult> {
  const { data, error } = await supabase.functions.invoke(
    "resolve-output-intent",
    {
      body: {
        document_kind: input.documentKind,
        organization_id: input.organizationId,
        branch_id: input.branchId ?? null,
        scenario: input.scenario ?? "default",
        document_id: input.documentId ?? null,
        triggered_source: input.triggeredSource ?? "api",
      },
    },
  );

  if (error) {
    return { resolved: false, reason: error.message };
  }
  return data as OutputIntentResult;
}
