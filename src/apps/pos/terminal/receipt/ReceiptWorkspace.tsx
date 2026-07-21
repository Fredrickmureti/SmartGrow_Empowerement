/**
 * ReceiptWorkspace — Phase-3c, route-owned surface for
 * `terminalState.phase === "receipt"`.
 *
 * Owns the post-payment workstation surface. The pixel-level implementation
 * (auto-print state machine, thermal/PDF fallback, receipt preview, cash-
 * drawer + customer-display side effects, hotkeys) lives in the shared
 * `PostPaymentSurface` module — which is also reused by `HistoryWorkspace`
 * for the reprint overlay so the two paths cannot drift.
 *
 * Slice B (Step 3 closeout): `PostPaymentSurface` now renders as a
 * workstation section (`absolute inset-0`) rather than a fixed dialog, so
 * this workspace no longer needs to wrap it in its own `<section>` — the
 * surface fills the terminal region provided by `TerminalShell` directly.
 *
 * Contract highlights:
 *  - Escape / New Sale dispatch `newSale` on the terminal reducer so the
 *    state machine decides when the terminal returns to `ready`.
 *  - `onNewSale` prop lets the host layer additional cart-owned resets
 *    (clearing `completedTransaction`) on top of the reducer transition.
 *
 * See `docs/architecture/POS_WORKSTATION_STATES.md`.
 */

import { useCallback } from "react";
import { PostPaymentScreen, type PrintPolicyHint } from "./PostPaymentSurface";
import type { LiveTransactionInput } from "@/lib/pos/receipt/ReceiptDocumentModel";
import { useTerminalContext } from "../TerminalStateContext";

interface ReceiptWorkspaceProps {
  transaction: LiveTransactionInput | null;
  policy: PrintPolicyHint;
  onEmail?: () => void;
  /**
   * Optional side-effect the host (POSTerminal, until Step 6) needs to
   * run when the workspace exits — clearing the local
   * `completedTransaction` mirror, resetting cart-owned state that the
   * reducer doesn't track. The workspace *always* dispatches `newSale`
   * itself; callers layer their own resets on top.
   */
  onNewSale?: () => void;
}

export function ReceiptWorkspace({
  transaction,
  policy,
  onEmail,
  onNewSale,
}: ReceiptWorkspaceProps) {
  const { dispatch, state } = useTerminalContext();

  const handleNewSale = useCallback(() => {
    onNewSale?.();
    dispatch({ kind: "op", op: "newSale" });
  }, [dispatch, onNewSale]);

  if (state.phase !== "receipt") return null;

  return (
    <PostPaymentScreen
      open
      transaction={transaction}
      policy={policy}
      onEmail={onEmail}
      onNewSale={handleNewSale}
    />
  );
}

export default ReceiptWorkspace;
