/**
 * Stage 4 contract tests — POS Reversal Saga engine.
 *
 * Drives `executeReversalSaga` against an in-memory `SagaClient` so
 * the invariants that keep the terminal out of split-brain state are
 * pinned as pure logic, independent of Supabase.
 *
 * Guaranteed invariants:
 *   1. Happy path runs every step in order and finalises `completed`.
 *   2. Failure in step N invokes compensations for steps [0..N-1] in
 *      REVERSE order, and finalises the workflow as `compensated`.
 *   3. A saga started with an existing `client_request_id` resumes
 *      without replaying already-completed steps.
 *   4. Completed workflows are idempotent — re-running the same
 *      command yields the same outcome without re-invoking `run`.
 *   5. The Stage 4 migration exposes the five RPCs the engine needs.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  executeReversalSaga,
  type SagaClient,
  type SagaStartResult,
  type SagaStepDefinition,
  type SagaStepRecord,
  type SagaWorkflowRecord,
} from "@/services/pos/reversal/saga";
import type { RefundSaleCommand } from "@/services/pos/reversal/commands";

// -------------------------------------------------------------------
// In-memory client — mirrors the server RPC state machine.
// -------------------------------------------------------------------
function makeMemoryClient(seed?: { workflow: SagaWorkflowRecord; steps: SagaStepRecord[] }) {
  const workflows = new Map<string, SagaWorkflowRecord>();
  const stepsByWorkflow = new Map<string, SagaStepRecord[]>();
  const byRequestId = new Map<string, string>();

  if (seed) {
    workflows.set(seed.workflow.id, seed.workflow);
    stepsByWorkflow.set(seed.workflow.id, seed.steps);
    byRequestId.set(seed.workflow.client_request_id, seed.workflow.id);
  }

  const client: SagaClient = {
    async start(input): Promise<SagaStartResult> {
      const existing = byRequestId.get(input.clientRequestId);
      if (existing) {
        return {
          workflow: workflows.get(existing)!,
          steps: stepsByWorkflow.get(existing)!,
          resumed: true,
        };
      }
      const id = `wf-${workflows.size + 1}`;
      const wf: SagaWorkflowRecord = {
        id,
        client_request_id: input.clientRequestId,
        command_type: input.commandType,
        status: "running",
        compensating_record_id: null,
        last_error: null,
      };
      workflows.set(id, wf);
      byRequestId.set(input.clientRequestId, id);
      stepsByWorkflow.set(
        id,
        input.stepPlan.map((s, i) => ({
          step_index: i,
          step_key: s.key,
          status: "pending",
          attempt_count: 0,
          request_payload: s.request_payload,
          result_payload: null,
          error: null,
        })),
      );
      return { workflow: wf, steps: stepsByWorkflow.get(id)!, resumed: false };
    },
    async startStep(workflowId, stepIndex) {
      const s = stepsByWorkflow.get(workflowId)!.find((x) => x.step_index === stepIndex)!;
      s.status = "running";
      s.attempt_count += 1;
    },
    async recordStep(workflowId, stepIndex, status, result, error) {
      const s = stepsByWorkflow.get(workflowId)!.find((x) => x.step_index === stepIndex)!;
      s.status = status;
      s.result_payload = result ?? s.result_payload;
      s.error = error;
    },
    async finalize(workflowId, status, compensatingRecordId, error) {
      const wf = workflows.get(workflowId)!;
      wf.status = status;
      wf.compensating_record_id = compensatingRecordId ?? wf.compensating_record_id;
      wf.last_error = error;
    },
  };

  return { client, workflows, stepsByWorkflow };
}

// -------------------------------------------------------------------
// Minimal RefundSaleCommand fixture.
// -------------------------------------------------------------------
function makeRefundCommand(clientRequestId = "req-1"): RefundSaleCommand {
  return {
    type: "refund_sale",
    clientRequestId,
    reasonCode: "customer_return",
    reason: "Test",
    managerOverrideId: null,
    envelope: {
      ready: true,
      organizationId: "org-1",
      businessId: "biz-1",
      branchId: "br-1",
      registerId: "reg-1",
      shiftId: "sh-1",
      cashierId: "cash-1",
    } as RefundSaleCommand["envelope"],
    transactionId: "txn-1",
    refundAmount: "100.00",
    currency: "USD",
    refundTenderMethod: "cash",
    bankAccountId: null,
  };
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------
describe("Stage 4 reversal saga — engine invariants", () => {
  it("runs every step in order and finalises completed on happy path", async () => {
    const { client, workflows, stepsByWorkflow } = makeMemoryClient();
    const calls: string[] = [];

    const steps: SagaStepDefinition[] = [
      {
        key: "reverse_tender",
        run: async () => {
          calls.push("reverse_tender");
          return { tender_id: "t-1" };
        },
      },
      {
        key: "post_refund_gl",
        run: async ({ priorResults }) => {
          calls.push("post_refund_gl");
          expect(priorResults.reverse_tender.tender_id).toBe("t-1");
          return { refund_id: "r-1" };
        },
      },
      {
        key: "emit_outbox",
        run: async () => {
          calls.push("emit_outbox");
          return { emitted: true };
        },
      },
    ];

    const outcome = await executeReversalSaga(client, {
      command: makeRefundCommand(),
      sourceTransactionId: "txn-1",
      steps,
      extractCompensatingRecordId: (r) => (r.post_refund_gl?.refund_id as string) ?? null,
    });

    expect(calls).toEqual(["reverse_tender", "post_refund_gl", "emit_outbox"]);
    expect(outcome.status).toBe("completed");
    expect(outcome.error).toBeNull();

    const wf = workflows.get(outcome.workflowId)!;
    expect(wf.status).toBe("completed");
    expect(wf.compensating_record_id).toBe("r-1");

    const persisted = stepsByWorkflow.get(outcome.workflowId)!;
    expect(persisted.map((s) => s.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("compensates completed steps in reverse order when a later step fails", async () => {
    const { client, workflows } = makeMemoryClient();
    const trace: string[] = [];

    const steps: SagaStepDefinition[] = [
      {
        key: "A",
        run: async () => {
          trace.push("run:A");
          return { a: 1 };
        },
        compensate: async () => {
          trace.push("comp:A");
        },
      },
      {
        key: "B",
        run: async () => {
          trace.push("run:B");
          return { b: 2 };
        },
        compensate: async () => {
          trace.push("comp:B");
        },
      },
      {
        key: "C",
        run: async () => {
          trace.push("run:C");
          throw new Error("C blew up");
        },
      },
    ];

    const outcome = await executeReversalSaga(client, {
      command: makeRefundCommand("req-fail"),
      sourceTransactionId: "txn-1",
      steps,
    });

    expect(trace).toEqual(["run:A", "run:B", "run:C", "comp:B", "comp:A"]);
    expect(outcome.status).toBe("compensated");
    expect(outcome.error).not.toBeNull();
    expect((outcome.error as { stepKey: string }).stepKey).toBe("C");
    expect(workflows.get(outcome.workflowId)!.status).toBe("compensated");
  });

  it("resumes an in-progress saga without re-running completed steps", async () => {
    // Seed a workflow where step 0 is already completed.
    const seededSteps: SagaStepRecord[] = [
      {
        step_index: 0,
        step_key: "A",
        status: "completed",
        attempt_count: 1,
        request_payload: {},
        result_payload: { a: "already-done" },
        error: null,
      },
      {
        step_index: 1,
        step_key: "B",
        status: "pending",
        attempt_count: 0,
        request_payload: {},
        result_payload: null,
        error: null,
      },
    ];
    const seededWorkflow: SagaWorkflowRecord = {
      id: "wf-seed",
      client_request_id: "req-resume",
      command_type: "refund_sale",
      status: "running",
      compensating_record_id: null,
      last_error: null,
    };
    const { client } = makeMemoryClient({ workflow: seededWorkflow, steps: seededSteps });

    let ranA = false;
    let sawPrior: unknown = null;
    const steps: SagaStepDefinition[] = [
      {
        key: "A",
        run: async () => {
          ranA = true;
          return { a: "should-not-run" };
        },
      },
      {
        key: "B",
        run: async ({ priorResults }) => {
          sawPrior = priorResults.A;
          return { b: 1 };
        },
      },
    ];

    const outcome = await executeReversalSaga(client, {
      command: makeRefundCommand("req-resume"),
      sourceTransactionId: "txn-1",
      steps,
    });

    expect(ranA).toBe(false);
    expect(sawPrior).toEqual({ a: "already-done" });
    expect(outcome.status).toBe("completed");
    expect(outcome.resumed).toBe(true);
  });

  it("returns the terminal outcome without side effects for a completed workflow", async () => {
    const seededSteps: SagaStepRecord[] = [
      {
        step_index: 0,
        step_key: "A",
        status: "completed",
        attempt_count: 1,
        request_payload: {},
        result_payload: { done: true },
        error: null,
      },
    ];
    const seededWorkflow: SagaWorkflowRecord = {
      id: "wf-done",
      client_request_id: "req-done",
      command_type: "refund_sale",
      status: "completed",
      compensating_record_id: "r-done",
      last_error: null,
    };
    const { client } = makeMemoryClient({ workflow: seededWorkflow, steps: seededSteps });

    let ran = false;
    const outcome = await executeReversalSaga(client, {
      command: makeRefundCommand("req-done"),
      sourceTransactionId: "txn-1",
      steps: [
        {
          key: "A",
          run: async () => {
            ran = true;
            return {};
          },
        },
      ],
    });

    expect(ran).toBe(false);
    expect(outcome.status).toBe("completed");
    expect(outcome.results.A).toEqual({ done: true });
  });
});

describe("Stage 4 reversal saga — server contract", () => {
  it("migration ships the five saga RPCs and both durable tables", () => {
    const migrationsDir = path.resolve(process.cwd(), "supabase/migrations");
    const files = fs.readdirSync(migrationsDir).map((f) => path.join(migrationsDir, f));
    const combined = files
      .filter((f) => f.endsWith(".sql"))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");

    for (const table of ["pos_reversal_workflow", "pos_reversal_step"]) {
      expect(combined).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
      expect(combined).toMatch(new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(combined).toMatch(new RegExp(`GRANT[^;]*ON public\\.${table}\\s+TO authenticated`, "i"));
    }
    for (const rpc of [
      "pos_reversal_workflow_start",
      "pos_reversal_step_start",
      "pos_reversal_step_record",
      "pos_reversal_workflow_finalize",
      "pos_reversal_workflow_get",
    ]) {
      expect(combined).toMatch(new RegExp(`FUNCTION public\\.${rpc}`));
      expect(combined).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}[^;]*TO authenticated`, "i"));
    }
  });
});
