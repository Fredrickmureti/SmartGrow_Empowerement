/**
 * useReversalSaga — Stage 4 client hook.
 *
 * Thin wrapper that binds `executeReversalSaga` to the production
 * `supabaseSagaClient`. Callers construct a `POSReversalCommand` +
 * a step plan; the hook returns a mutation-shaped API that reports
 * `resumed`/`compensated`/`completed` so the UI can render the
 * correct copy for each terminal state.
 *
 * Notes:
 *   - This hook does NOT open the manager override dialog. That is
 *     still the caller's job (via `useOverridePolicy` + the existing
 *     dialog) — by the time the command is handed here, its
 *     `managerOverrideId` is either populated or explicitly null.
 *   - Toast copy is the caller's job too. This hook is pure
 *     orchestration.
 */

import * as React from "react";
import {
  executeReversalSaga,
  type SagaExecutionInput,
  type SagaExecutionOutcome,
} from "@/services/pos/reversal/saga";
import { supabaseSagaClient } from "@/services/pos/reversal/sagaClient";

export interface UseReversalSagaState {
  status: "idle" | "running" | "success" | "error";
  outcome: SagaExecutionOutcome | null;
  error: unknown;
}

export function useReversalSaga() {
  const [state, setState] = React.useState<UseReversalSagaState>({
    status: "idle",
    outcome: null,
    error: null,
  });

  const run = React.useCallback(async (input: SagaExecutionInput) => {
    setState({ status: "running", outcome: null, error: null });
    try {
      const outcome = await executeReversalSaga(supabaseSagaClient, input);
      const success =
        outcome.status === "completed" && outcome.error === null;
      setState({
        status: success ? "success" : "error",
        outcome,
        error: outcome.error,
      });
      return outcome;
    } catch (err) {
      setState({ status: "error", outcome: null, error: err });
      throw err;
    }
  }, []);

  const reset = React.useCallback(
    () => setState({ status: "idle", outcome: null, error: null }),
    [],
  );

  return { ...state, run, reset };
}
