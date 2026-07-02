/**
 * useIsLikelyMobile — progressive feature-detection for "this device can
 * realistically be used as a same-device scanner" (i.e. has a touchscreen
 * camera the user can point at a barcode).
 *
 * Used to decide whether to surface same-device scanner pairing affordances
 * (the "Pair this device" button and in-app QR viewfinder).
 *
 * Previous implementation gated on `window.innerWidth < 900`, which
 * excluded:
 *   - large modern phones in landscape (Galaxy Fold, Ultra-class devices,
 *     iPhone Pro Max in landscape can exceed 900px CSS px)
 *   - every tablet (iPad, Galaxy Tab, Surface in tablet mode)
 *   - foldables in unfolded state
 *
 * The fix: trust the platform signals (`pointer: coarse`, `hover: none`,
 * `maxTouchPoints`) and use width only as a soft upper bound to rule out
 * laptops with touchscreens. Any device whose primary pointer is a finger
 * and which has no hover capability is treated as scanner-capable.
 */

import { useEffect, useState } from "react";

// Hard upper bound — beyond this we assume a large-screen device that's
// almost certainly not handheld (TVs, presentation displays). Set high
// enough that every tablet and unfolded foldable qualifies.
const MAX_HANDHELD_WIDTH_PX = 1600;

function compute(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const noHover = window.matchMedia?.("(hover: none)").matches ?? false;
  const touch = (navigator.maxTouchPoints ?? 0) > 0;
  const withinHandheldRange = window.innerWidth <= MAX_HANDHELD_WIDTH_PX;
  // Primary signal: touch-first input model. Width is only a sanity gate.
  return touch && coarse && noHover && withinHandheldRange;
}

export function useIsLikelyMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => compute());
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => setIsMobile(compute());
    window.addEventListener("resize", onChange);
    const mqPointer = window.matchMedia?.("(pointer: coarse)");
    const mqHover = window.matchMedia?.("(hover: none)");
    mqPointer?.addEventListener?.("change", onChange);
    mqHover?.addEventListener?.("change", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      mqPointer?.removeEventListener?.("change", onChange);
      mqHover?.removeEventListener?.("change", onChange);
    };
  }, []);
  return isMobile;
}
