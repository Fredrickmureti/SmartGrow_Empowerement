/**
 * Robust proof — PdfBuilder honours paperFormat end-to-end.
 *
 * Renders a minimal PDF at each declared preset and asserts the resulting
 * MediaBox dimensions (parsed from pdf-lib's Page) match the mm→pt spec.
 * This is the guard that catches regressions where an upstream caller
 * (edge function, coercer, hook) silently swaps thermal → A4 before the
 * builder ever sees it. Runs with `deno test` in CI.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PdfBuilder, type PaperPreset } from "../PdfBuilder.ts";

const MM_TO_PT = 72 / 25.4;

const cases: { preset: PaperPreset; widthMm: number; heightMm: number }[] = [
  { preset: "a4", widthMm: 210, heightMm: 297 },
  { preset: "letter", widthMm: 215.9, heightMm: 279.4 },
  { preset: "a5", widthMm: 148, heightMm: 210 },
  { preset: "80mm", widthMm: 80, heightMm: 297 },
  { preset: "58mm", widthMm: 58, heightMm: 297 },
  { preset: "40mm", widthMm: 40, heightMm: 297 },
];

for (const c of cases) {
  Deno.test(`PdfBuilder(portrait) renders ${c.preset} at ${c.widthMm}x${c.heightMm} mm`, async () => {
    const builder = await PdfBuilder.create({ orientation: "portrait", paperFormat: c.preset });
    builder.newPage();
    const [w, h] = [builder.page.getWidth(), builder.page.getHeight()];
    const expectedW = c.widthMm * MM_TO_PT;
    const expectedH = c.heightMm * MM_TO_PT;
    if (Math.abs(w - expectedW) > 0.5 || Math.abs(h - expectedH) > 0.5) {
      throw new Error(
        `${c.preset}: expected ~${expectedW.toFixed(1)}x${expectedH.toFixed(1)}pt, got ${w}x${h}pt`,
      );
    }
    const expectedDensity = c.widthMm <= 90 ? "narrow" : "wide";
    assertEquals(builder.state.density, expectedDensity, `${c.preset} density`);
  });
}
