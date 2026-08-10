/**
 * Collections work queue — the prioritised action list.
 *
 * The queue is a server-side view (`collections_work_queue`) over the canonical
 * AR net position joined to the operational overlays (collector, dunning level,
 * open promise, open dispute). Priority is scored in SQL so every collector,
 * report and automation ranks the same way. Never re-rank or re-derive the
 * exposure in the browser.
 */
import { supabase } from "@/integrations/supabase/client";
import type { DunningActionType } from "@/services/finance/dunning";

export interface WorkQueueRow {
  contactId: string;
  contactName: string | null;
  netAmount: number;
  notDue: number;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  maxDaysOverdue: number;
  collectorUserId: string | null;
  dunningLevelName: string | null;
  nextAction: DunningActionType | null;
  promiseId: string | null;
  promisedAmount: number | null;
  expectedPaymentDate: string | null;
  disputedAmount: number;
  inDispute: boolean;
  inPromise: boolean;
  priorityScore: number;
}

function mapRow(r: Record<string, unknown>): WorkQueueRow {
  return {
    contactId: String(r.contact_id),
    contactName: (r.contact_name as string) ?? null,
    netAmount: Number(r.net_amount) || 0,
    notDue: Number(r.not_due) || 0,
    current: Number(r.current_bucket) || 0,
    days30: Number(r.days30) || 0,
    days60: Number(r.days60) || 0,
    days90: Number(r.days90) || 0,
    maxDaysOverdue: Number(r.max_days_overdue) || 0,
    collectorUserId: (r.collector_user_id as string) ?? null,
    dunningLevelName: (r.dunning_level_name as string) ?? null,
    nextAction: (r.next_action as DunningActionType) ?? null,
    promiseId: (r.promise_id as string) ?? null,
    promisedAmount:
      r.promised_amount === null || r.promised_amount === undefined
        ? null
        : Number(r.promised_amount),
    expectedPaymentDate: (r.expected_payment_date as string) ?? null,
    disputedAmount: Number(r.disputed_amount) || 0,
    inDispute: Boolean(r.in_dispute),
    inPromise: Boolean(r.in_promise),
    priorityScore: Number(r.priority_score) || 0,
  };
}

export async function fetchCollectionsWorkQueue(params: {
  businessId: string;
  collectorUserId?: string | null;
}): Promise<WorkQueueRow[]> {
  const { data, error } = await supabase.rpc(
    "get_collections_work_queue" as never,
    {
      _business_id: params.businessId,
      _collector_user_id: params.collectorUserId ?? null,
    } as never,
  );
  if (error) throw error;
  return ((data as unknown as Array<Record<string, unknown>>) ?? []).map(mapRow);
}
