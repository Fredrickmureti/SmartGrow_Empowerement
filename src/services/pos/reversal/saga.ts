/**
 * POS Reversal Saga Engine — Stage 4.
 *
 * Kills F4: partial failures mid-reversal (cash reversed, but store-
 * credit note write blows up) that used to leave the terminal in a
 * split-brain state where receipts, GL, and inventory disagreed.
 *
 * Design rules:
 *   - Durable state lives in `pos_reversal_workflow` + `pos_reversal_step`.
 *     Idempotency is keyed by `command.clientRequestId` — starting the
 *     same saga twice returns the existing workflow rather than
 *     duplicating side effects.
 *   - Steps are ordered. Each step is `run(ctx)` and, optionally,
 *     `compensate(ctx, result)`. Compensations run in reverse order
 *     if a later step fails.
 *   - Step results are persisted verbatim so a resumed saga can hand
 *     the next step whatever ids the previous one produced.
 *   - No toasts, no UI. `useReversalSaga` wraps this with feedback.
 *
 * The engine is deliberately transport-agnostic: it talks to the DB
 * through the injected `sagaClient` so vitest can drive it against
 * an in-memory fake without hitting Supabase.
 */

import type { POSReversalCommand } from "./commands";

export type SagaStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "compensated";

export type SagaWorkflowStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "compensating"
  | "compensated";

export interface SagaStepRecord {
  step_index: number;
  step_key: string;
  status: SagaStepStatus;
  attempt_count: number;
  request_payload: Record<string, unknown>;
  result_payload: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

export interface SagaWorkflowRecord {
  id: string;
  client_request_id: string;
  command_type: string;
  status: SagaWorkflowStatus;
  compensating_record_id: string | null;
  last_error: Record<string, unknown> | null;
}

export interface SagaStartResult {
  workflow: SagaWorkflowRecord;
  steps: SagaStepRecord[];
  resumed: boolean;
}

/**
 * Transport contract. The real implementation calls the five Stage 4
 * RPCs; tests plug in an in-memory version.
 */
export interface SagaClient {
  start(input: {
    clientRequestId: string;
    commandType: string;
    commandPayload: Record<string, unknown>;
    organizationId: string;
    businessId: string;
    branchId: string | null;
    registerId: string | null;
    shiftId: string | null;
    cashierId: string | null;
    managerOverrideId: string | null;
    sourceTransactionId: string | null;
    stepPlan: ReadonlyArray<{ key: string; request_payload: Record<string, unknown> }>;
  }): Promise<SagaStartResult>;
  startStep(workflowId: string, stepIndex: number): Promise<void>;
  recordStep(
    workflowId: string,
    stepIndex: number,
    status: Exclude<SagaStepStatus, "pending" | "running">,
    result: Record<string, unknown> | null,
    error: Record<string, unknown> | null,
  ): Promise<void>;
  finalize(
    workflowId: string,
    status: Exclude<SagaWorkflowStatus, "pending" | "running">,
    compensatingRecordId: string | null,
    error: Record<string, unknown> | null,
  ): Promise<void>;
}

export interface SagaStepContext {
  workflowId: string;
  stepIndex: number;
  command: POSReversalCommand;
  /** Merged result payloads of previously-completed steps, keyed by step_key. */
  priorResults: Record<string, Record<string, unknown>>;
}

export interface SagaStepDefinition {
  key: string;
  requestPayload?: Record<string, unknown>;
  /**
   * Perform the leg. Return a JSON-serialisable result — it becomes
   * `priorResults[key]` for downstream steps and is persisted verbatim.
   * Throw on failure; the engine records the error and compensates.
   */
  run: (ctx: SagaStepContext) => Promise<Record<string, unknown>>;
  /**
   * Optional inverse. Runs when a later step fails. Should be
   * idempotent — the engine may retry after a resume.
   */
  compensate?: (
    ctx: SagaStepContext,
    result: Record<string, unknown>,
  ) => Promise<void>;
}

export interface SagaExecutionInput {
  command: POSReversalCommand;
  sourceTransactionId: string | null;
  steps: ReadonlyArray<SagaStepDefinition>;
  /**
   * Optional record id (refund/credit-note/return) to hoist to the
   * workflow row on success. When omitted the engine leaves the
   * field null.
   */
  extractCompensatingRecordId?: (
    priorResults: Record<string, Record<string, unknown>>,
  ) => string | null;
}

export interface SagaExecutionOutcome {
  workflowId: string;
  status: SagaWorkflowStatus;
  results: Record<string, Record<string, unknown>>;
  error: { stepKey: string; error: unknown } | null;
  resumed: boolean;
}

const toErrorPayload = (err: unknown): Record<string, unknown> => {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack ?? null };
  }
  if (typeof err === "object" && err !== null) {
    return err as Record<string, unknown>;
  }
  return { message: String(err) };
};

/**
 * Run a reversal saga end-to-end.
 *
 * Contract:
 *   - Start (or resume) the workflow via `sagaClient.start`.
 *   - For each planned step whose recorded status is not `completed`
 *     or `skipped`, invoke `run(ctx)`.
 *   - On success, record `completed` with the result.
 *   - On failure, record `failed`, compensate every completed step in
 *     reverse order, finalize the workflow as `compensated` (or
 *     `failed` if no compensations existed), and return the outcome.
 *   - On success across all steps, finalize as `completed`.
 */
export async function executeReversalSaga(
  sagaClient: SagaClient,
  input: SagaExecutionInput,
): Promise<SagaExecutionOutcome> {
  const { command, steps } = input;

  const startResult = await sagaClient.start({
    clientRequestId: command.clientRequestId,
    commandType: command.type,
    commandPayload: command as unknown as Record<string, unknown>,
    organizationId: command.envelope.organizationId,
    businessId: command.envelope.businessId,
    branchId: command.envelope.branchId ?? null,
    registerId: command.envelope.registerId ?? null,
    shiftId: command.envelope.shiftId ?? null,
    cashierId: command.envelope.cashierId ?? null,
    managerOverrideId: command.managerOverrideId ?? null,
    sourceTransactionId: input.sourceTransactionId,
    stepPlan: steps.map((s) => ({
      key: s.key,
      request_payload: s.requestPayload ?? {},
    })),
  });

  const persistedByIndex = new Map<number, SagaStepRecord>();
  for (const step of startResult.steps) {
    persistedByIndex.set(step.step_index, step);
  }

  const priorResults: Record<string, Record<string, unknown>> = {};
  for (const step of startResult.steps) {
    if (step.status === "completed" && step.result_payload) {
      priorResults[step.step_key] = step.result_payload;
    }
  }

  // If the saga previously finalized, honour that outcome.
  if (
    startResult.workflow.status === "completed" ||
    startResult.workflow.status === "compensated" ||
    startResult.workflow.status === "failed"
  ) {
    return {
      workflowId: startResult.workflow.id,
      status: startResult.workflow.status,
      results: priorResults,
      error: startResult.workflow.last_error
        ? { stepKey: "(prior)", error: startResult.workflow.last_error }
        : null,
      resumed: startResult.resumed,
    };
  }

  const completedForCompensation: Array<{
    def: SagaStepDefinition;
    result: Record<string, unknown>;
    index: number;
  }> = [];

  for (let i = 0; i < steps.length; i += 1) {
    const def = steps[i];
    const persisted = persistedByIndex.get(i);
    if (persisted && (persisted.status === "completed" || persisted.status === "skipped")) {
      if (persisted.result_payload && def.compensate) {
        completedForCompensation.push({
          def,
          result: persisted.result_payload,
          index: i,
        });
      }
      continue;
    }

    await sagaClient.startStep(startResult.workflow.id, i);
    try {
      const result = await def.run({
        workflowId: startResult.workflow.id,
        stepIndex: i,
        command,
        priorResults,
      });
      await sagaClient.recordStep(
        startResult.workflow.id,
        i,
        "completed",
        result,
        null,
      );
      priorResults[def.key] = result;
      if (def.compensate) {
        completedForCompensation.push({ def, result, index: i });
      }
    } catch (err) {
      await sagaClient.recordStep(
        startResult.workflow.id,
        i,
        "failed",
        null,
        toErrorPayload(err),
      );

      // Compensate in reverse order. Best-effort; we record but do not
      // throw on compensation failures — the workflow row keeps the
      // original error for operator triage.
      for (let j = completedForCompensation.length - 1; j >= 0; j -= 1) {
        const c = completedForCompensation[j];
        try {
          await c.def.compensate!(
            {
              workflowId: startResult.workflow.id,
              stepIndex: c.index,
              command,
              priorResults,
            },
            c.result,
          );
          await sagaClient.recordStep(
            startResult.workflow.id,
            c.index,
            "compensated",
            c.result,
            null,
          );
        } catch (compErr) {
          await sagaClient.recordStep(
            startResult.workflow.id,
            c.index,
            "compensated",
            c.result,
            toErrorPayload(compErr),
          );
        }
      }

      const finalStatus: SagaWorkflowStatus =
        completedForCompensation.length > 0 ? "compensated" : "failed";
      await sagaClient.finalize(
        startResult.workflow.id,
        finalStatus,
        null,
        toErrorPayload(err),
      );
      return {
        workflowId: startResult.workflow.id,
        status: finalStatus,
        results: priorResults,
        error: { stepKey: def.key, error: err },
        resumed: startResult.resumed,
      };
    }
  }

  const compensatingRecordId =
    input.extractCompensatingRecordId?.(priorResults) ?? null;
  await sagaClient.finalize(
    startResult.workflow.id,
    "completed",
    compensatingRecordId,
    null,
  );

  return {
    workflowId: startResult.workflow.id,
    status: "completed",
    results: priorResults,
    error: null,
    resumed: startResult.resumed,
  };
}
