/**
 * execForIntent — the single resolve-then-dispatch seam.
 *
 * Phase 5 Step B. Every non-React consumer that needs "print this / open
 * that" expresses **business intent** (`receipt`, `label`, `kitchen_ticket`,
 * or a bare hardware role) plus org/business context. This module asks the
 * server-authoritative `resolve_device` RPC which `device_assignments` row
 * wins, then dispatches through `hardwareClient.execAssignment` so
 * `TransportRouter` reads the transport off the winning row.
 *
 * Applications never name a device, a transport, or a driver. That is the
 * whole point of the hardware platform boundary: Sales says "print the
 * customer invoice", the platform decides *where*.
 *
 * When org context is missing or the resolver returns nothing, the call
 * fails loudly with a named error instead of silently guessing a device by
 * role — a non-deterministic print is worse than a visible refusal.
 */
import { hardwareClient } from '@/services/hardware/HardwareClient';
import { resolveDeviceForIntent } from '@/hooks/useDeviceForIntent';
import type { DeviceRole } from '@/services/hardware/drivers/DriverInterface';

export interface ExecForIntentInput {
  /** `PrintIntent` (receipt | kitchen_ticket | label | a4_document | packing_slip) or a bare role. */
  intentOrRole: string;
  op: string;
  payload?: unknown;
  organizationId?: string | null;
  businessId?: string | null;
  scope?: { kind: 'register' | 'station' | 'user' | 'tenant'; id?: string };
  idempotencyKey?: string;
  maxAttempts?: number;
  sourceDocType?: string | null;
  sourceDocId?: string | null;
  businessEventId?: string | null;
  isReprint?: boolean;
}

export interface ExecForIntentResult {
  success: boolean;
  error?: string;
  /** The `device_assignments.id` the platform routed to, when resolved. */
  assignmentId?: string | null;
  bytesWritten?: number;
}

/** Stable error code UIs can key on to offer the "bind a device" CTA. */
export const NO_DEVICE_BOUND = 'no_device_bound';

export async function execForIntent(input: ExecForIntentInput): Promise<ExecForIntentResult> {
  if (!input.organizationId) {
    return {
      success: false,
      error: `${NO_DEVICE_BOUND}: missing organization context for intent '${input.intentOrRole}'`,
      assignmentId: null,
    };
  }

  let resolved: Awaited<ReturnType<typeof resolveDeviceForIntent>> = null;
  try {
    resolved = await resolveDeviceForIntent({
      organizationId: input.organizationId,
      intentOrRole: input.intentOrRole,
      businessId: input.businessId ?? null,
      scope: input.scope as never,
    });
  } catch (err) {
    return {
      success: false,
      error: `device resolver unavailable: ${err instanceof Error ? err.message : String(err)}`,
      assignmentId: null,
    };
  }

  if (!resolved) {
    return {
      success: false,
      error: `${NO_DEVICE_BOUND}: no device is bound for '${input.intentOrRole}'`,
      assignmentId: null,
    };
  }

  // eslint-disable-next-line no-console
  console.info('[hardware.route.decision]', {
    stage: 'exec-for-intent',
    intent: input.intentOrRole,
    role: resolved.role,
    assignmentId: resolved.id,
    businessId: input.businessId ?? null,
  });

  const res = await hardwareClient.execAssignment({
    assignment: {
      id: resolved.id,
      role: resolved.role as DeviceRole,
      transport: resolved.transport,
      enabled: resolved.enabled,
    },
    op: input.op,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey,
    maxAttempts: input.maxAttempts,
    sourceDocType: input.sourceDocType ?? null,
    sourceDocId: input.sourceDocId ?? null,
    businessEventId: input.businessEventId ?? null,
    isReprint: input.isReprint,
  });

  return { ...res, assignmentId: resolved.id };
}
