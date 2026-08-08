/**
 * Recurring invoice template lifecycle — the single client-side source of
 * truth for what a template state means and which transitions are legal.
 *
 * The database owns enforcement (`set_recurring_status_atomic` plus a write
 * guard trigger). This module exists so the UI can disable illegal actions
 * instead of discovering them through an error toast.
 */
export type RecurringInvoiceStatus = "active" | "paused" | "cancelled" | "completed";

export const RECURRING_TRANSITIONS: Record<RecurringInvoiceStatus, RecurringInvoiceStatus[]> = {
  active: ["paused", "cancelled", "completed"],
  paused: ["active", "cancelled"],
  cancelled: [],
  completed: [],
};

export function canTransitionRecurring(
  from: RecurringInvoiceStatus,
  to: RecurringInvoiceStatus,
): boolean {
  return RECURRING_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalRecurringStatus(status: RecurringInvoiceStatus): boolean {
  return RECURRING_TRANSITIONS[status]?.length === 0;
}

export const RECURRING_STATUS_LABEL: Record<RecurringInvoiceStatus, string> = {
  active: "Active",
  paused: "Paused",
  cancelled: "Cancelled",
  completed: "Completed",
};

/**
 * Delivery outcomes recorded on a billing run. `blocked` is the honest answer
 * to "auto-send was requested but the invoice never became sendable".
 */
export type RecurringDeliveryStatus =
  | "pending"
  | "not_applicable"
  | "queued"
  | "sent"
  | "failed"
  | "blocked";

export const RECURRING_DELIVERY_LABEL: Record<RecurringDeliveryStatus, string> = {
  pending: "Queued for email",
  not_applicable: "No email requested",
  queued: "Queued",
  sent: "Emailed",
  failed: "Email failed",
  blocked: "Not sent — needs confirmation",
};

/** Email retry backoff, in minutes, indexed by attempt number (0-based). */
export const DELIVERY_BACKOFF_MINUTES = [5, 15, 60, 240, 720];
export const MAX_DELIVERY_ATTEMPTS = DELIVERY_BACKOFF_MINUTES.length;

export function nextDeliveryRetryAt(attempt: number, from: Date = new Date()): Date | null {
  if (attempt >= MAX_DELIVERY_ATTEMPTS) return null;
  const minutes = DELIVERY_BACKOFF_MINUTES[attempt];
  return new Date(from.getTime() + minutes * 60_000);
}
