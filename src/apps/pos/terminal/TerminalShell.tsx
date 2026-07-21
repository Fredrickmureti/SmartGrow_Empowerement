/**
 * TerminalShell — layout route for `/pos/terminal/:registerId`.
 *
 * Responsibilities (Phase 1 cutover):
 *   1. Read the initial shift state for this register so the reducer
 *      can pick its starting phase (idle vs ready) BEFORE the sale
 *      surface mounts. Live shift/cart deltas flow in from
 *      `<TerminalStateBridge>` inside the sale surface.
 *   2. Mount `<TerminalStateProvider>` so every workspace, sheet, and
 *      rail rendered underneath can call `useTerminalContext()`.
 *   3. Render the current phase surface via `<Outlet />`.
 *
 * Follow-up phases will extract Tender/Receipt/Return/Held/History
 * from `POSTerminal.tsx` into sibling routes under this shell. Until
 * then, the sole child route is the legacy `POSTerminal` page which
 * still hosts every phase internally — but now inside the provider,
 * so extraction can proceed one workspace at a time without a
 * flag-day rewrite.
 *
 * See `docs/architecture/POS_WORKSTATION_STATES.md` and
 * `docs/audit/2026-07-21-pos-terminal-architecture.md`.
 */

import { Outlet, useParams } from "react-router-dom";
import { usePOSShifts } from "@/hooks/pos/usePOSShifts";
import { TerminalStateProvider } from "./TerminalStateContext";

export default function TerminalShell() {
  const { registerId } = useParams<{ registerId: string }>();

  // Same source of truth POSTerminal uses; react-query dedupes the
  // second subscription so this is not an extra network call.
  const { currentShift, userCurrentShift } = usePOSShifts(registerId);
  const activeShift =
    currentShift ||
    (userCurrentShift?.register_id === registerId ? userCurrentShift : null);
  const hasActiveShift = !!activeShift;

  return (
    <TerminalStateProvider
      hasActiveShift={hasActiveShift}
      cartHasItems={false}
      hasUnreadCompletion={false}
    >
      <Outlet />
    </TerminalStateProvider>
  );
}
