/**
 * Terminal state machine — the single source of truth for which
 * workspace + sheet are on screen at a POS terminal.
 *
 * See `docs/architecture/POS_WORKSTATION_STATES.md` for the state chart,
 * transition table, and the sheets-vs-workspaces rule this reducer
 * enforces.
 *
 * This reducer never mutates cart, shift, or hardware state — those
 * live in existing hooks (`usePOSCartAdapter`, `usePOSShifts`,
 * `usePOSTransactionOffline`, `useHardwareProxy`, …). It answers a
 * single question: "which workspace and which sheet is on screen?"
 */

import type { DomainEvent, DomainEventType } from "@/services/events/domainEventBus";

export type TerminalPhase =
  | "idle"
  | "ready"
  | "sale"
  | "tender"
  | "receipt"
  | "return"
  | "held"
  | "history"
  | "locked";

/**
 * Sheet identifiers. New sheets MUST be added here and to the
 * per-phase allow-list in `SHEETS_ALLOWED_PER_PHASE` below.
 */
export type SheetId =
  // line-scoped
  | "line.discount"
  | "line.unit"
  | "line.modifier"
  | "line.override"
  // sale-scoped
  | "sale.customer"
  | "sale.loyalty"
  | "sale.age"
  | "sale.hold"
  | "sale.billSplit"
  | "sale.tableTransfer"
  // cross-cutting
  | "managerOverride"
  | "unlock"
  // receipt-scoped
  | "receipt.sendDocument";

export interface CompletedTransactionSnapshot {
  transactionId: string;
  receiptNumber: string | null;
  total: number;
  paidAt: string;
  // Payload the receipt workspace needs to render/reprint; deliberately
  // opaque here so the reducer stays decoupled from the receipt schema.
  payload: unknown;
}

export interface TerminalState {
  phase: TerminalPhase;
  /**
   * When phase === 'locked' this remembers where to return on unlock.
   * When entering a side-transition (return/held/history) this remembers
   * the phase to restore on `closeSide`.
   */
  previousPhase: TerminalPhase | null;
  activeSheet: SheetId | null;
  splitPortionToPay: unknown | null; // SplitBillPortion shape owned by cart module
  tipAmount: number;
  paymentSessionIdempotencyKey: string;
  completedTransaction: CompletedTransactionSnapshot | null;
}

export type TerminalIntent =
  | { kind: "event"; event: DomainEvent }
  | {
      kind: "op";
      op:
        | "openTender"
        | "backToSale"
        | "newSale"
        | "openReturn"
        | "openHeld"
        | "openHistory"
        | "closeSide"
        | "lock"
        | "unlock"
        | "holdCart"
        | "clearCart"
        | "shiftOpened"
        | "shiftClosed";
      /**
       * For `openTender` — the reducer freezes an idempotency key at the
       * moment the operator enters tender. Retail passes the amount-bound
       * key; restaurant passes the draft transaction id. The reducer does
       * not compute this — the caller supplies it, keeping the retail-vs-
       * restaurant contract identical to the pre-refactor behaviour.
       */
      idempotencyKey?: string;
      splitPortion?: unknown;
      tipAmount?: number;
    }
  | { kind: "op"; op: "openSheet"; sheet: SheetId }
  | { kind: "op"; op: "closeSheet" }
  | { kind: "op"; op: "setTip"; tipAmount: number }
  | { kind: "op"; op: "recordCompletion"; transaction: CompletedTransactionSnapshot };

/**
 * Sheets allowed per phase. `SheetShell` (rendered inside each workspace)
 * checks this table and refuses to render if the current sheet is not
 * permitted in the current phase — the auto-dismiss-on-phase-change rule.
 */
export const SHEETS_ALLOWED_PER_PHASE: Record<TerminalPhase, ReadonlyArray<SheetId>> = {
  idle: [],
  ready: ["sale.customer", "managerOverride"],
  sale: [
    "line.discount",
    "line.unit",
    "line.modifier",
    "line.override",
    "sale.customer",
    "sale.loyalty",
    "sale.age",
    "sale.hold",
    "sale.billSplit",
    "sale.tableTransfer",
    "managerOverride",
  ],
  tender: ["managerOverride"],
  receipt: ["receipt.sendDocument"],
  return: ["line.override", "managerOverride"],
  held: ["managerOverride"],
  history: ["managerOverride"],
  locked: ["unlock"],
};

/**
 * Business events that cause phase transitions. Anything not in this set
 * is ignored by the reducer (though it may drive other subscribers).
 */
const PHASE_DRIVING_EVENTS: ReadonlySet<DomainEventType> = new Set<DomainEventType>([
  "sale.committed",
  "pos.payment_completed",
  "pos.session_idle",
]);

export const INITIAL_TERMINAL_STATE: TerminalState = {
  phase: "idle",
  previousPhase: null,
  activeSheet: null,
  splitPortionToPay: null,
  tipAmount: 0,
  paymentSessionIdempotencyKey: "",
  completedTransaction: null,
};

/**
 * Compute the phase implied by cart + shift + last-completed state.
 * Used on mount and after `newSale` to pick the right starting workspace.
 */
export function derivePhase(input: {
  hasActiveShift: boolean;
  cartHasItems: boolean;
  hasUnreadCompletion: boolean;
}): TerminalPhase {
  if (!input.hasActiveShift) return "idle";
  if (input.hasUnreadCompletion) return "receipt";
  if (input.cartHasItems) return "sale";
  return "ready";
}

/**
 * Pure reducer. Illegal transitions return the state unchanged rather
 * than throwing so a stale event replay from the outbox cannot brick
 * the workstation.
 */
export function terminalReducer(state: TerminalState, intent: TerminalIntent): TerminalState {
  // Sheet operations — legal in every phase, guarded by the per-phase
  // allow-list so callers can't spawn a sheet that doesn't belong here.
  if (intent.kind === "op" && intent.op === "openSheet") {
    if (!SHEETS_ALLOWED_PER_PHASE[state.phase].includes(intent.sheet)) return state;
    return { ...state, activeSheet: intent.sheet };
  }
  if (intent.kind === "op" && intent.op === "closeSheet") {
    return state.activeSheet == null ? state : { ...state, activeSheet: null };
  }
  if (intent.kind === "op" && intent.op === "setTip") {
    return { ...state, tipAmount: intent.tipAmount };
  }
  if (intent.kind === "op" && intent.op === "recordCompletion") {
    return {
      ...state,
      completedTransaction: intent.transaction,
      phase: "receipt",
      previousPhase: state.phase,
      activeSheet: null,
    };
  }

  // Business events drive phase changes when they represent a committed
  // saga step. `sale.committed` / `pos.payment_completed` graduate the
  // terminal to receipt; `pos.session_idle` (emitted by
  // CustomerDisplayShim after an idle timeout) returns it to ready.
  if (intent.kind === "event") {
    const type = intent.event.type;
    if (!PHASE_DRIVING_EVENTS.has(type)) return state;
    if ((type === "sale.committed" || type === "pos.payment_completed") && state.phase === "tender") {
      return {
        ...state,
        phase: "receipt",
        previousPhase: "tender",
        activeSheet: null,
      };
    }
    if (type === "pos.session_idle" && (state.phase === "receipt" || state.phase === "sale")) {
      return {
        ...INITIAL_TERMINAL_STATE,
        phase: "ready",
      };
    }
    return state;
  }

  if (intent.kind === "op") {
    switch (intent.op) {
      case "shiftOpened":
        return state.phase === "idle" ? { ...state, phase: "ready", previousPhase: "idle" } : state;
      case "shiftClosed":
        return { ...INITIAL_TERMINAL_STATE, phase: "idle" };
      case "openTender":
        if (state.phase !== "sale") return state;
        return {
          ...state,
          phase: "tender",
          previousPhase: "sale",
          activeSheet: null,
          splitPortionToPay: intent.splitPortion ?? state.splitPortionToPay,
          tipAmount: intent.tipAmount ?? state.tipAmount,
          paymentSessionIdempotencyKey:
            intent.idempotencyKey ?? state.paymentSessionIdempotencyKey,
        };
      case "backToSale":
        if (state.phase !== "tender") return state;
        return { ...state, phase: "sale", previousPhase: "tender", activeSheet: null };
      case "newSale":
        return {
          ...INITIAL_TERMINAL_STATE,
          phase: "ready",
        };
      case "openReturn":
      case "openHeld":
      case "openHistory": {
        const next: TerminalPhase =
          intent.op === "openReturn" ? "return" : intent.op === "openHeld" ? "held" : "history";
        if (state.phase === "tender" || state.phase === "receipt" || state.phase === "idle") return state;
        return { ...state, phase: next, previousPhase: state.phase, activeSheet: null };
      }
      case "closeSide":
        if (!(state.phase === "return" || state.phase === "held" || state.phase === "history")) return state;
        return {
          ...state,
          phase: state.previousPhase ?? "ready",
          previousPhase: state.phase,
          activeSheet: null,
        };
      case "lock":
        if (state.phase === "idle" || state.phase === "locked") return state;
        return { ...state, phase: "locked", previousPhase: state.phase, activeSheet: "unlock" };
      case "unlock":
        if (state.phase !== "locked") return state;
        return {
          ...state,
          phase: state.previousPhase ?? "ready",
          previousPhase: "locked",
          activeSheet: null,
        };
      case "holdCart":
        // Held cart returns terminal to ready (side-transition to /held
        // is a separate operator intent). Cart clearing is owned by the
        // cart hook — the reducer only tracks the workspace.
        return state.phase === "sale"
          ? { ...state, phase: "ready", previousPhase: "sale", activeSheet: null }
          : state;
      case "clearCart":
        return state.phase === "sale"
          ? { ...state, phase: "ready", previousPhase: "sale", activeSheet: null }
          : state;
    }
  }

  return state;
}

/**
 * Map phase → route segment relative to `/pos/terminal/:registerId`.
 * `idle` and `ready` share the shell root; the shell renders the
 * appropriate empty-state or open-shift prompt.
 */
export function phaseToPath(phase: TerminalPhase): string {
  switch (phase) {
    case "idle":
    case "ready":
    case "locked":
      return "";
    case "sale":
      return "sale";
    case "tender":
      return "tender";
    case "receipt":
      return "receipt";
    case "return":
      return "return";
    case "held":
      return "held";
    case "history":
      return "history";
  }
}
