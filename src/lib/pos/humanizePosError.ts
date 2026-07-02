/**
 * Map raw Postgres / PostgREST error messages from POS RPCs to short,
 * cashier-friendly strings. Strips trailing UUIDs and rewrites the
 * cash-variance complaint into something a human can act on.
 */
export function humanizePosError(message: string | null | undefined): string {
  const raw = (message ?? "").trim();
  if (!raw) return "Something went wrong. Please try again.";

  // Cash variance: "Cash variance X exceeds tolerance Y for shift Z..."
  const variance = raw.match(
    /Cash variance\s+(-?[\d,.]+)\s+exceeds tolerance\s+([\d,.]+)/i,
  );
  if (variance) {
    return `Cash variance ${variance[1]} exceeds tolerance ${variance[2]}. A manager must approve the override before closing.`;
  }

  if (/Manager override.*required/i.test(raw)) {
    return "A manager override is required to complete this action.";
  }
  if (/Shift not found/i.test(raw)) return "That shift no longer exists.";
  if (/is not open/i.test(raw)) return "This shift is already closed.";
  if (/Reason is required/i.test(raw) || /A reason is required/i.test(raw)) {
    return "Please provide a reason before continuing.";
  }
  if (/Invalid manager PIN/i.test(raw)) return "Manager PIN was not accepted.";
  if (/pos_shifts_variance_override_pin_id_fkey/i.test(raw)) {
    return "The manager approval could not be attached to this shift. Please approve again and retry.";
  }
  if (/foreign key constraint/i.test(raw)) {
    return "This action references a record that no longer matches the current shift. Please refresh and try again.";
  }
  if (/override_not_found|override_expired|override_already_consumed/i.test(raw)) {
    return "That manager approval is no longer valid. Please enter the manager PIN again.";
  }
  if (/override_(org|business|shift|action)_mismatch|override_role_not_allowed/i.test(raw)) {
    return "That manager approval is not valid for this shift.";
  }

  // Strip trailing UUIDs
  return raw.replace(
    /\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.?/gi,
    "",
  ).trim() || "Something went wrong. Please try again.";
}
