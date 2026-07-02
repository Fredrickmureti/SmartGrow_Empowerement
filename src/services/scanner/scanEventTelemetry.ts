/**
 * Desk-side `scan_events` telemetry sender.
 *
 * The desk hook (`useScanChannel` / `usePOSScannerChannel`) calls
 * `sendScanEvent(...)` after every non-pending ACK it broadcasts back to
 * the phone. The RPC is SECURITY DEFINER, has its own 30/min/device rate
 * limit, and runs inside the database — so failures here must NEVER
 * affect ACK delivery or surface in the UI.
 */

import { supabase } from "@/integrations/supabase/client";

export type ScanEventVerdict = "ok" | "weighted" | "unknown" | "error" | "pending";
export type ScanEventSource = "camera" | "manual" | "wedge" | "phone";

export interface ScanEventInput {
  sessionId?: string | null;
  registerId?: string | null;
  workspaceId?: string | null;
  deviceId: string;
  code: string;
  seq: number;
  /** Phone-stamp epoch ms (or desk fallback). */
  decodedAt: number;
  verdict: ScanEventVerdict;
  workflow: string | null | undefined;
  source: ScanEventSource;
}

/**
 * Build the RPC payload. Pure for unit-testing the wire contract.
 * `decoded_at` is sent as ISO-8601 so the server's
 * `latency_ms = received_at - decoded_at` math is timezone-independent.
 */
export function buildScanEventPayload(input: ScanEventInput) {
  return {
    session_id: input.sessionId ?? null,
    register_id: input.registerId ?? null,
    workspace_id: input.workspaceId ?? null,
    device_id: input.deviceId,
    code: input.code,
    seq: input.seq,
    decoded_at: new Date(input.decodedAt).toISOString(),
    verdict: input.verdict,
    workflow: input.workflow ?? null,
    source: input.source,
  };
}

/**
 * Fire-and-forget: invokes `log_scan_event(p jsonb)`. Swallows ALL errors.
 * Returns a promise that always resolves, never rejects.
 */
export async function sendScanEvent(input: ScanEventInput): Promise<void> {
  try {
    // Untyped RPC: this fn is declared in the database but not in the
    // generated supabase types union yet.
    await (
      supabase.rpc as unknown as (
        name: string,
        args: unknown,
      ) => Promise<{ error: unknown }>
    )("log_scan_event", { p: buildScanEventPayload(input) });
  } catch {
    // Telemetry must never affect operator scans.
  }
}