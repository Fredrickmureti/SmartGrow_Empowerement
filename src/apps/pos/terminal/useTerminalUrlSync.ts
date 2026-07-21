/**
 * useTerminalUrlSync — bidirectional bridge between the terminal state
 * machine's `phase` and the browser URL under `/pos/terminal/:registerId`.
 *
 * Contract (see `docs/architecture/POS_WORKSTATION_STATES.md`):
 *   - State → URL: whenever `phase` changes, the URL is `replace`d to the
 *     matching segment via `phaseToPath`. `idle` / `ready` / `locked`
 *     collapse to the shell root — they are not user-visible phases the
 *     cashier would deep-link into.
 *   - URL → State: on mount and on route-driven navigation (browser
 *     back/forward, deep link, F5), the hook inspects the trailing
 *     segment and dispatches the appropriate operator intent so the
 *     reducer catches up. Illegal deep links (e.g. `/tender` while there
 *     is no active sale) are ignored by the reducer and corrected on the
 *     next State → URL sync — no throw, no white screen.
 *
 * The hook never navigates OFF the terminal shell; a bad segment is
 * silently normalised to the shell root by the State → URL half.
 */

import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTerminalContext } from "./TerminalStateContext";
import { phaseToPath, type TerminalPhase } from "./useTerminalState";

const SEGMENT_TO_PHASE: Record<string, TerminalPhase> = {
  sale: "sale",
  tender: "tender",
  receipt: "receipt",
  return: "return",
  held: "held",
  history: "history",
};

function segmentFor(pathname: string, registerId: string | undefined): string {
  if (!registerId) return "";
  const marker = `/pos/terminal/${registerId}`;
  const idx = pathname.indexOf(marker);
  if (idx < 0) return "";
  const rest = pathname.slice(idx + marker.length).replace(/^\/+/, "").replace(/\/+$/, "");
  // Only consider the FIRST segment after the register id; deeper paths
  // (future workspace sub-routes) are ignored by the sync.
  return rest.split("/")[0] ?? "";
}

export function useTerminalUrlSync(): void {
  const { registerId } = useParams<{ registerId: string }>();
  const { state, dispatch } = useTerminalContext();
  const navigate = useNavigate();
  const location = useLocation();

  // Guard against the two-way loop: after we push a URL change, the
  // location effect fires; we must not then re-dispatch the intent that
  // produced it. The ref records the segment the state-writer just set.
  const lastWrittenSegment = useRef<string | null>(null);

  // State → URL
  useEffect(() => {
    if (!registerId) return;
    const wanted = phaseToPath(state.phase);
    const current = segmentFor(location.pathname, registerId);
    if (wanted === current) return;
    const base = `/pos/terminal/${registerId}`;
    const target = wanted ? `${base}/${wanted}` : base;
    lastWrittenSegment.current = wanted;
    navigate(target + location.search + location.hash, { replace: true });
  }, [state.phase, registerId, location.pathname, location.search, location.hash, navigate]);

  // URL → State (deep links, back/forward, F5)
  useEffect(() => {
    if (!registerId) return;
    const segment = segmentFor(location.pathname, registerId);
    if (segment === lastWrittenSegment.current) {
      lastWrittenSegment.current = null;
      return;
    }
    const targetPhase = SEGMENT_TO_PHASE[segment];
    if (!targetPhase) return;
    if (targetPhase === state.phase) return;

    // Map the target phase to the operator intent the reducer accepts.
    // Tender/receipt cannot be entered by URL alone — they require a
    // committed business event (cart present → openTender, payment
    // committed → recordCompletion). We leave those to the reducer and
    // let the State → URL half correct the address bar.
    switch (targetPhase) {
      case "return":
        dispatch({ kind: "op", op: "openReturn" });
        break;
      case "held":
        dispatch({ kind: "op", op: "openHeld" });
        break;
      case "history":
        dispatch({ kind: "op", op: "openHistory" });
        break;
      case "sale":
        // Sale is entered by adding an item to the cart; a bare
        // /sale URL with an empty cart is not a legal deep link. The
        // State → URL half will send the operator back to the shell.
        break;
      default:
        break;
    }
  }, [location.pathname, registerId, state.phase, dispatch]);
}
