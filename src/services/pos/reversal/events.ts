/**
 * POS Reversal Event Vocabulary — Stage 2 of the POS refund/reversal
 * remediation (see `.lovable/plan.md`).
 *
 * These are the canonical topic names that every reversal command emits
 * to `business_event_outbox`. They MUST match the topics registered in
 * `business_event_topics`. Do not fork this vocabulary — new consumers
 * subscribe to these names, not to raw table changes.
 *
 * Rationale (see plan F2/F4):
 *   The audit found four overlapping "reverse" implementations, none
 *   of which emitted a consistent outbox event. Downstream analytics,
 *   receipt reprinting, and fiscal transmission subscribed to whatever
 *   was closest to hand, producing divergent state. This module is the
 *   single source of truth for the event names.
 */

import type { POSReversalCommandType, POSReversalReasonCode } from "./reasonCodes";

export const POS_REVERSAL_EVENT_TOPICS = {
  void_sale: "pos.sale.voided",
  reverse_card_authorization: "pos.card.reversed",
  refund_sale: "pos.sale.refunded",
  return_goods: "pos.goods.returned",
  exchange: "pos.sale.exchanged",
  issue_store_credit: "pos.store_credit.issued",
} as const satisfies Record<POSReversalCommandType, string>;

export type POSReversalEventTopic =
  (typeof POS_REVERSAL_EVENT_TOPICS)[POSReversalCommandType];

/**
 * Fixed shape of the payload written to `business_event_outbox.payload`.
 * The saga (Stage 4) is responsible for populating every field; producers
 * that omit required fields fail the outbox schema at insertion time.
 */
export interface POSReversalEventPayload {
  event_topic: POSReversalEventTopic;
  command_type: POSReversalCommandType;
  reason_code: POSReversalReasonCode;
  /** Free-text reason captured from the manager override / operator. */
  reason: string;
  /** ID of the source POS transaction being reversed. */
  source_transaction_id: string;
  /** ID of the compensating transaction / refund / return record. */
  compensating_record_id: string | null;
  /**
   * Manager override id (references `pos_manager_overrides`). Required
   * whenever the policy matrix demanded approval.
   */
  manager_override_id: string | null;
  /** Envelope identity, copied verbatim from the terminal envelope. */
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  register_id: string | null;
  shift_id: string | null;
  cashier_id: string | null;
  /** Money amounts are numeric strings to avoid float drift downstream. */
  gross_amount: string;
  tax_amount: string;
  net_amount: string;
  currency: string;
  /** Client-supplied idempotency key; every retry MUST reuse it. */
  client_request_id: string;
  /** ISO-8601 timestamp of the command dispatch. */
  dispatched_at: string;
  /** Envelope schema version, so consumers can gate on breaking changes. */
  envelope_version: number;
}

export function topicForCommand(
  command: POSReversalCommandType,
): POSReversalEventTopic {
  return POS_REVERSAL_EVENT_TOPICS[command];
}
