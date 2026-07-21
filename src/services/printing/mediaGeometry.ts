/**
 * mediaGeometry — single owner of physical-mm → printer-dot conversion.
 *
 * ADR-0087 (Phase 14). Prior to this module, four call sites carried
 * their own copy of `dpmm = dpi / 25.4; dots = round(mm * dpmm)`:
 *
 *   - `electron/hardware/drivers/ZplLabelDriver.ts`
 *   - `electron/hardware/drivers/EplLabelDriver.ts`
 *   - `src/services/hardware/BrowserHardwareAdapter.ts` (× 2 — ZPL + EPL)
 *   - the label-template preview canvas
 *
 * With five copies of the same rounding rule, "why is the label 2 dots
 * off?" investigations had to check five files. This module is the one
 * owner. Drivers, the browser adapter fallback, and the preview canvas
 * all import from here. New physical media (labels, receipts, sheets)
 * pick up the same math automatically.
 *
 * The module is deliberately pure and free of `supabase` /
 * `hardwareClient` / DOM imports so it is client-safe (React preview
 * canvas) AND Node-safe (Electron drivers) with a single build target.
 * `no-server-only-in-client` and `no-browser-globals-in-server` tests
 * pass by construction — there are no imports.
 *
 * Guardrail: `src/test/printing/media-geometry-single-owner.test.ts`
 * asserts that (a) this module has no `import` statements outside
 * `type` imports (the file below is intentionally import-free), and
 * (b) the drivers + preview import from here rather than re-declaring
 * `dpi / 25.4`.
 */

/** Default DPI for label printers that don't report their own. Zebra /
 *  many EPL2 units at 203 dpi = 8 dpmm. Overridden by
 *  `printer_profiles.dpi`. */
export const DEFAULT_LABEL_DPI = 203;

/** dots per millimetre at the given DPI. Pure `dpi / 25.4`. */
export function dotsPerMm(dpi: number): number {
  if (!Number.isFinite(dpi) || dpi <= 0) return DEFAULT_LABEL_DPI / 25.4;
  return dpi / 25.4;
}

/** Convert a millimetre length to printer dots. Rounds to the nearest
 *  whole dot and clamps at 1 dot (printers reject 0-dot commands). */
export function mmToDots(mm: number, dpi: number): number {
  if (!Number.isFinite(mm) || mm <= 0) return 1;
  return Math.max(1, Math.round(mm * dotsPerMm(dpi)));
}

/** Full media geometry snapshot in printer dots. `heightDots` may be
 *  omitted for continuous media where the height is unknown at label
 *  time; callers should degrade gracefully (drivers currently only emit
 *  the length envelope when height is known). */
export function mediaDots(input: { widthMm: number; heightMm?: number | null; dpi: number }): {
  widthDots: number;
  heightDots: number | null;
  dpmm: number;
} {
  const dpmm = dotsPerMm(input.dpi);
  return {
    widthDots: mmToDots(input.widthMm, input.dpi),
    heightDots:
      input.heightMm == null || !Number.isFinite(input.heightMm) || input.heightMm <= 0
        ? null
        : mmToDots(input.heightMm as number, input.dpi),
    dpmm,
  };
}

/** Convert a printer-dot count back to CSS pixels for a preview canvas,
 *  where `previewDpi` is the effective screen DPI you want to render at
 *  (usually 96 for CSS 1×). Kept here so preview and driver share one
 *  scaling formula.
 *
 *  `cssPx = mm * (previewDpi / 25.4)` — no rounding, the canvas handles
 *  sub-pixel positioning itself. */
export function mmToCssPx(mm: number, previewDpi = 96): number {
  if (!Number.isFinite(mm) || mm <= 0) return 0;
  return mm * (previewDpi / 25.4);
}
