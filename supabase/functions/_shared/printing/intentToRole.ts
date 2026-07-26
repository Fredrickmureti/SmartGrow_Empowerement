/**
 * intentToRole — server-side twin of `src/hooks/useDeviceForIntent.ts::INTENT_TO_ROLE`.
 *
 * Kept in one Deno-visible module so the `generate-document` edge function
 * and the browser UI never disagree on which hardware role a print intent
 * maps to. The client-side parity guard
 * (`src/test/architecture/intent-to-role-parity.test.ts`) locks the client
 * map to the canonical `DeviceRole` union; this file MUST stay a strict
 * subset of the same mapping.
 *
 * Adding a new intent: update BOTH this map AND the client one in the same
 * change. Anything else drifts the resolver on server vs. UI.
 */
export const INTENT_TO_ROLE: Record<string, string> = {
  receipt: "receipt_printer",
  kitchen_ticket: "kitchen_printer",
  label: "label_printer",
  a4_document: "a4_printer",
  packing_slip: "a4_printer",
};

/**
 * Resolve the hardware role for a print intent (or a bare role string).
 * Returns `null` for unknown intents so callers can fall through to
 * legacy ID-based routing rather than dispatching to nothing.
 */
export function roleForIntent(intent: string | null | undefined): string | null {
  if (!intent) return null;
  return INTENT_TO_ROLE[intent] ?? intent;
}
