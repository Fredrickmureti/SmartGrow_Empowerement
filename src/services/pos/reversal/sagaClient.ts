/**
 * Supabase-backed SagaClient — the production transport for the
 * Stage 4 reversal saga engine. Thin wrapper over the five RPCs
 * introduced in the Stage 4 migration.
 */

import { supabase } from "@/integrations/supabase/client";
import type {
  SagaClient,
  SagaStartResult,
  SagaStepRecord,
  SagaWorkflowRecord,
  SagaWorkflowStatus,
  SagaStepStatus,
} from "./saga";

interface RawStart {
  workflow: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  resumed: boolean;
}

const parseWorkflow = (row: Record<string, unknown>): SagaWorkflowRecord => ({
  id: String(row.id),
  client_request_id: String(row.client_request_id),
  command_type: String(row.command_type),
  status: row.status as SagaWorkflowStatus,
  compensating_record_id: (row.compensating_record_id as string | null) ?? null,
  last_error: (row.last_error as Record<string, unknown> | null) ?? null,
});

const parseStep = (row: Record<string, unknown>): SagaStepRecord => ({
  step_index: Number(row.step_index),
  step_key: String(row.step_key),
  status: row.status as SagaStepStatus,
  attempt_count: Number(row.attempt_count ?? 0),
  request_payload: (row.request_payload as Record<string, unknown>) ?? {},
  result_payload: (row.result_payload as Record<string, unknown> | null) ?? null,
  error: (row.error as Record<string, unknown> | null) ?? null,
});

export const supabaseSagaClient: SagaClient = {
  async start(input) {
    const { data, error } = await supabase.rpc(
      // @ts-expect-error — RPC name; regenerated types will cover this after next `supabase gen types`.
      "pos_reversal_workflow_start",
      {
        p_client_request_id: input.clientRequestId,
        p_command_type: input.commandType,
        p_command_payload: input.commandPayload,
        p_organization_id: input.organizationId,
        p_business_id: input.businessId,
        p_branch_id: input.branchId,
        p_register_id: input.registerId,
        p_shift_id: input.shiftId,
        p_cashier_id: input.cashierId,
        p_manager_override_id: input.managerOverrideId,
        p_source_transaction_id: input.sourceTransactionId,
        p_step_plan: input.stepPlan,
      },
    );
    if (error) throw error;
    const raw = data as unknown as RawStart;
    const result: SagaStartResult = {
      workflow: parseWorkflow(raw.workflow),
      steps: raw.steps.map(parseStep),
      resumed: Boolean(raw.resumed),
    };
    return result;
  },
  async startStep(workflowId, stepIndex) {
    const { error } = await supabase.rpc(
      // @ts-expect-error — RPC name; regenerated types will cover this.
      "pos_reversal_step_start",
      { p_workflow_id: workflowId, p_step_index: stepIndex },
    );
    if (error) throw error;
  },
  async recordStep(workflowId, stepIndex, status, result, error) {
    const { error: err } = await supabase.rpc(
      // @ts-expect-error — RPC name; regenerated types will cover this.
      "pos_reversal_step_record",
      {
        p_workflow_id: workflowId,
        p_step_index: stepIndex,
        p_status: status,
        p_result: result,
        p_error: error,
      },
    );
    if (err) throw err;
  },
  async finalize(workflowId, status, compensatingRecordId, error) {
    const { error: err } = await supabase.rpc(
      // @ts-expect-error — RPC name; regenerated types will cover this.
      "pos_reversal_workflow_finalize",
      {
        p_workflow_id: workflowId,
        p_status: status,
        p_compensating_record_id: compensatingRecordId,
        p_error: error,
      },
    );
    if (err) throw err;
  },
};
