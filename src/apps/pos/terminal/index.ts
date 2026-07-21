/**
 * Terminal module barrel.
 *
 * This module implements the POS workstation as defined in
 * `docs/architecture/POS_WORKSTATION_STATES.md`. Every workspace, sheet,
 * and rail component under `/pos/terminal/:registerId` MUST live in this
 * folder or an approved sub-folder.
 *
 * Wire-up into `src/apps/pos/routes.tsx` happens incrementally as each
 * workspace is extracted from `src/pages/pos/POSTerminal.tsx` (see the
 * phased plan in `docs/audit/2026-07-21-pos-terminal-architecture.md`).
 */

export { TerminalStateProvider, useTerminalContext } from "./TerminalStateContext";
export { SheetShell } from "./SheetShell";
export {
  derivePhase,
  terminalReducer,
  phaseToPath,
  INITIAL_TERMINAL_STATE,
  SHEETS_ALLOWED_PER_PHASE,
  type CompletedTransactionSnapshot,
  type SheetId,
  type TerminalIntent,
  type TerminalPhase,
  type TerminalState,
} from "./useTerminalState";
