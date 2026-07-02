/**
 * BodyPointerEventsGuard
 *
 * Defensive recovery for a well-known Radix UI invariant violation:
 * Radix Dialog/Sheet/AlertDialog set `pointer-events: none` on `<body>`
 * when an overlay opens, and remove it on close. If the overlay is
 * unmounted while still `open` (route navigation, conditional render
 * flipping, parent state racing the overlay's own close cleanup), the
 * style is never removed and the entire app becomes unclickable while
 * still scrolling.
 *
 * This component watches `<body>`'s `style` attribute via MutationObserver
 * and clears `pointer-events: none` whenever there is no actually-open
 * Radix overlay in the DOM. It does NOT prevent legitimate scroll-locks
 * — when a real overlay is open, the style is preserved.
 *
 * Mount once, near the top of the authenticated tree.
 */

import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Selectors that indicate an actually-mounted, currently-open Radix overlay.
 * If any of these match, we leave `<body>` alone — Radix is doing its job.
 */
const OPEN_OVERLAY_SELECTORS = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  // Sheet/Drawer also use role="dialog"; covered above.
].join(",");

function hasOpenOverlay(): boolean {
  return document.querySelector(OPEN_OVERLAY_SELECTORS) !== null;
}

/**
 * Sweep every attribute Radix (and friends) leave behind when an overlay
 * is unmounted while still open. Empirically the failure modes we've hit
 * in POS Settings are:
 *
 *   - `<body style="pointer-events: none">`           (Dialog scroll lock)
 *   - `<body data-scroll-locked="…">`                 (Radix scroll-area lock)
 *   - `<body aria-hidden="true">` / `<#root aria-hidden="true">` (focus trap)
 *   - `<#root inert>` / `<main inert>`                (focus trap, modern)
 *
 * When the route changes but any of these residues survive, the new page
 * paints correctly but the user can't click anything and the UI looks
 * "stuck on the previous screen". We only clear when there is provably
 * no open overlay in the DOM, so legitimate scroll-locks are preserved.
 */
function maybeClearStuckOverlayResidue(reason: string): void {
  if (typeof document === "undefined") return;
  if (hasOpenOverlay()) return;

  const body = document.body;
  if (!body) return;

  let cleared = false;

  // 1. body pointer-events lock
  if (body.style.pointerEvents === "none") {
    body.style.pointerEvents = "";
    cleared = true;
  }

  // 2. scroll-locked attribute
  if (body.hasAttribute("data-scroll-locked")) {
    body.removeAttribute("data-scroll-locked");
    cleared = true;
  }

  // 3. focus-trap residue on body / #root / main
  const trapNodes = [body, document.getElementById("root"), document.querySelector("main")];
  for (const node of trapNodes) {
    if (!node) continue;
    if (node.getAttribute("aria-hidden") === "true") {
      node.removeAttribute("aria-hidden");
      cleared = true;
    }
    // `inert` is a boolean attribute — presence alone disables interaction.
    if (node.hasAttribute("inert")) {
      node.removeAttribute("inert");
      cleared = true;
    }
  }

  if (cleared && process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn(
      `[BodyPointerEventsGuard] Cleared stuck overlay residue (${reason}). ` +
        "A Radix Dialog/Sheet/AlertDialog likely unmounted while still open.",
    );
  }
}

export function BodyPointerEventsGuard(): null {
  const { pathname } = useLocation();

  useEffect(() => {
    if (typeof document === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (reason: string) => {
      if (timer) clearTimeout(timer);
      // Debounce so Radix's own cleanup gets a chance to run first.
      timer = setTimeout(() => maybeClearStuckOverlayResidue(reason), 100);
    };

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes") {
          schedule(`attr:${m.attributeName ?? "?"}`);
          return;
        }
        if (m.type === "childList" && m.removedNodes.length > 0) {
          schedule("removedNode");
          return;
        }
      }
    });

    // Watch body + #root + <main> for the four residue attrs. Focus-trap
    // libraries (Radix included) commonly set `inert` / `aria-hidden` on
    // the sibling of the portal, NOT on body — so observing body alone
    // misses the freeze that strands `inert` on #root.
    const attrTargets: (Element | null)[] = [
      document.body,
      document.getElementById("root"),
      document.querySelector("main"),
    ];
    for (const t of attrTargets) {
      if (!t) continue;
      observer.observe(t, {
        attributes: true,
        attributeFilter: ["style", "aria-hidden", "inert", "data-scroll-locked"],
      });
    }
    // Body subtree childList covers overlay portal mount/unmount churn.
    observer.observe(document.body, { childList: true, subtree: true });

    schedule("mount");

    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Route-change sweep: every navigation forces a clean slate, regardless
  // of whether the MutationObserver caught the residue. Runs synchronously
  // BEFORE paint so the new route never paints under a stranded `inert`
  // or `aria-hidden` from the previous route's overlays — followed by a
  // deferred sweep so any unmount cleanup that fires after commit is also
  // caught.
  useLayoutEffect(() => {
    maybeClearStuckOverlayResidue("route-change:layout");
  }, [pathname]);
  useEffect(() => {
    const t = setTimeout(() => maybeClearStuckOverlayResidue("route-change:deferred"), 0);
    return () => clearTimeout(t);
  }, [pathname]);

  return null;
}

export default BodyPointerEventsGuard;
