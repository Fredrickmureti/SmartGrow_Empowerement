/**
 * TerminalStateContext — provides the workstation reducer to every
 * workspace, sheet, and rail component under `/pos/terminal/:registerId`.
 *
 * The context also wires the reducer to `domainEventBus` so `sale.*`
 * events emitted by SaleSaga/cart-adapter automatically drive phase
 * transitions without the UI polling for state changes.
 *
 * See `docs/architecture/POS_WORKSTATION_STATES.md` for the contract.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { domainEventBus, type DomainEvent } from "@/services/events/domainEventBus";
import {
  INITIAL_TERMINAL_STATE,
  SHEETS_ALLOWED_PER_PHASE,
  derivePhase,
  terminalReducer,
  type SheetId,
  type TerminalIntent,
  type TerminalState,
} from "./useTerminalState";

interface TerminalContextValue {
  state: TerminalState;
  dispatch: (intent: TerminalIntent) => void;
  openSheet: (sheet: SheetId) => void;
  closeSheet: () => void;
  isSheetOpen: (sheet: SheetId) => boolean;
  canOpenSheet: (sheet: SheetId) => boolean;
}

const TerminalStateContext = createContext<TerminalContextValue | null>(null);

interface TerminalStateProviderProps {
  children: ReactNode;
  hasActiveShift: boolean;
  cartHasItems: boolean;
  hasUnreadCompletion?: boolean;
}

/**
 * Bridge component — call this once, near the top of `POSTerminal`, to
 * push live shift/cart booleans into the reducer. The provider itself
 * takes only INITIAL values (so it can pick a starting phase); the
 * bridge keeps them in sync as they change.
 *
 * Kept as a component (not a hook) so it can be dropped into JSX
 * without threading dispatch through props.
 */
export function TerminalStateBridge({
  hasActiveShift,
  cartHasItems,
}: {
  hasActiveShift: boolean;
  cartHasItems: boolean;
}) {
  const { dispatch } = useTerminalContext();
  useEffect(() => {
    dispatch({ kind: "op", op: hasActiveShift ? "shiftOpened" : "shiftClosed" });
  }, [hasActiveShift, dispatch]);
  useEffect(() => {
    dispatch({ kind: "op", op: "syncCart", cartHasItems });
  }, [cartHasItems, dispatch]);
  return null;
}


export function TerminalStateProvider({
  children,
  hasActiveShift,
  cartHasItems,
  hasUnreadCompletion = false,
}: TerminalStateProviderProps) {
  const [state, dispatch] = useReducer(terminalReducer, undefined, () => ({
    ...INITIAL_TERMINAL_STATE,
    phase: derivePhase({ hasActiveShift, cartHasItems, hasUnreadCompletion }),
  }));

  // Subscribe to committed business events. The reducer decides which
  // ones drive phase transitions (see PHASE_DRIVING_EVENTS). Shift and
  // cart deltas flow in via <TerminalStateBridge>, not here — the
  // provider only picks the INITIAL phase.
  useEffect(() => {
    const unsub = domainEventBus.on("*", (event: DomainEvent) => {
      dispatch({ kind: "event", event });
    });
    return () => unsub();
  }, []);


  const openSheet = useCallback((sheet: SheetId) => dispatch({ kind: "op", op: "openSheet", sheet }), []);
  const closeSheet = useCallback(() => dispatch({ kind: "op", op: "closeSheet" }), []);
  const isSheetOpen = useCallback((sheet: SheetId) => state.activeSheet === sheet, [state.activeSheet]);
  const canOpenSheet = useCallback(
    (sheet: SheetId) => SHEETS_ALLOWED_PER_PHASE[state.phase].includes(sheet),
    [state.phase],
  );

  const value = useMemo<TerminalContextValue>(
    () => ({ state, dispatch, openSheet, closeSheet, isSheetOpen, canOpenSheet }),
    [state, openSheet, closeSheet, isSheetOpen, canOpenSheet],
  );

  return <TerminalStateContext.Provider value={value}>{children}</TerminalStateContext.Provider>;
}

export function useTerminalContext(): TerminalContextValue {
  const ctx = useContext(TerminalStateContext);
  if (!ctx) {
    throw new Error(
      "useTerminalContext must be used inside <TerminalStateProvider>. " +
        "Every POS workspace and sheet under /pos/terminal/:registerId must render inside the provider.",
    );
  }
  return ctx;
}
