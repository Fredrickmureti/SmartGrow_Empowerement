/**
 * ReceiptWorkspace — Phase-3c, route-owned surface for
 * `terminalState.phase === "receipt"`.
 *
 * Replaces the ad-hoc `<PostPaymentScreen>` mount inside `POSTerminal`
 * with a real workstation workspace: a `<section>` that fills the
 * terminal region provided by `TerminalShell`, no `<Dialog>` chrome,
 * and whose exit (New Sale) dispatches `newSale` on the terminal
 * reducer so the state machine — not a sibling `useState` — decides
 * when the terminal returns to `ready`.
 *
 * The pixel-level content (money-first hero, print status pill,
 * auto-print state machine, save-PDF / reprint / reconnect controls,
 * receipt preview toggle) is deliberately delegated to
 * `<PostPaymentScreen>` because that same component is also used by
 * `<TransactionHistoryDialog>` for the reprint path. Forking it into
 * two implementations would duplicate ~700 LOC of hardware
 * integration and drift over time; Step 4 (HistoryWorkspace) collapses
 * the last remaining `<TransactionHistoryDialog>` consumer, at which
 * point `PostPaymentScreen`'s implementation can be inlined here and
 * the shim deleted.
 *
 * Contract highlights:
 *  - Full-region absolute section (`inset-0 z-40`) — matches
 *    `TenderWorkspace` and `HeldWorkspace`.
 *  - Escape and the Back button both dispatch `newSale` (Enter on the
 *    keypad hotkey layer inside `PostPaymentScreen` does the same via
 *    its `onNewSale` callback).
 *  - The reducer's `completedTransaction` snapshot is *not* the full
 *    thermal-render payload — this workspace takes the live
 *    `LiveTransactionInput` via props so the auto-print path stays
 *    identical to the pre-refactor behaviour. When
 *    `SaleWorkspace` decomposition lands (Step 6), the payload moves
 *    into `terminalState.completedTransaction.payload` and this
 *    prop-drilling goes away.
 *
 * See `docs/architecture/POS_WORKSTATION_STATES.md`.
 */

import { useCallback, useEffect } from "react";
import { PostPaymentScreen, type PrintPolicyHint } from "@/components/pos/PostPaymentScreen";
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

  // ESC returns to `ready` via `newSale` — same exit affordance as
  // TenderWorkspace's back-to-sale. `PostPaymentScreen` also binds
  // Enter/Escape internally to `onNewSale`; the extra listener here is
  // a defence for the moment the inner component is unmounting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      handleNewSale();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNewSale]);

  if (state.phase !== "receipt") return null;

  return (
    <section
      aria-labelledby="receipt-workspace-title"
      className="absolute inset-0 z-40 flex flex-col bg-background"
    >
      <h1 id="receipt-workspace-title" className="sr-only">
        Transaction complete
      </h1>
      <PostPaymentScreen
        open
        transaction={transaction}
        policy={policy}
        onEmail={onEmail}
        onNewSale={handleNewSale}
      />
    </section>
  );
}

export default ReceiptWorkspace;
