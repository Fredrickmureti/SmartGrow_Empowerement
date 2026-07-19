/**
 * Robust proof — PdfBuilder honours paperFormat end-to-end.
 *
 * Fixed-height presets (A4 / Letter / A5): MediaBox equals the mm→pt spec.
 * Continuous presets (80/58/40mm thermal): width matches the spec,
 * heightMode === "continuous", and save() crops the media box down to the
 * consumed content height. This is what ADR-0008 Phase T1 introduces:
 * thermal PDFs no longer render as tall blank strips.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PdfBuilder, type PaperPreset } from "../PdfBuilder.ts";

const MM_TO_PT = 72 / 25.4;

type Case =
  | { preset: PaperPreset; widthMm: number; heightMm: number; mode: "fixed" }
  | { preset: PaperPreset; widthMm: number; mode: "continuous" };

const cases: Case[] = [
  { preset: "a4", widthMm: 210, heightMm: 297, mode: "fixed" },
  { preset: "letter", widthMm: 215.9, heightMm: 279.4, mode: "fixed" },
  { preset: "a5", widthMm: 148, heightMm: 210, mode: "fixed" },
  { preset: "80mm", widthMm: 80, mode: "continuous" },
  { preset: "58mm", widthMm: 58, mode: "continuous" },
  { preset: "40mm", widthMm: 40, mode: "continuous" },
];

for (const c of cases) {
  Deno.test(`PdfBuilder(portrait) ${c.preset} — ${c.mode}`, async () => {
    const builder = await PdfBuilder.create({ orientation: "portrait", paperFormat: c.preset });
    builder.newPage();
    const w = builder.page.getWidth();
    const expectedW = c.widthMm * MM_TO_PT;
    if (Math.abs(w - expectedW) > 0.5) {
      throw new Error(`${c.preset}: expected width ~${expectedW.toFixed(1)}pt, got ${w}pt`);
    }
    const expectedDensity = c.widthMm <= 90 ? "narrow" : "wide";
    assertEquals(builder.state.density, expectedDensity, `${c.preset} density`);
    assertEquals(builder.state.heightMode, c.mode, `${c.preset} heightMode`);

    if (c.mode === "fixed") {
      const h = builder.page.getHeight();
      const expectedH = c.heightMm * MM_TO_PT;
      if (Math.abs(h - expectedH) > 0.5) {
        throw new Error(`${c.preset}: expected height ~${expectedH.toFixed(1)}pt, got ${h}pt`);
      }
    } else {
      // Simulate a short "receipt": draw ~40pt of content by dropping the
      // cursor, then save. The media box must crop to that content, NOT
      // remain a tall 297mm strip (the pre-T1 defect the user reported).
      const initialY = builder.y;
      builder.y = initialY - 40;
      await builder.save();
      const finalHeight = builder.page.getHeight();
      // Final height should equal consumed (40pt) + top margin (initial
      // header space above cursor) + bottomMargin (6pt narrow). Well
      // under the 297mm (~842pt) pre-T1 output.
      const preT1Height = 297 * MM_TO_PT; // ~842pt
      if (finalHeight >= preT1Height - 1) {
        throw new Error(
          `${c.preset}: continuous save() did not crop — got ${finalHeight}pt, ` +
            `expected << ${preT1Height.toFixed(1)}pt (pre-T1 fixed height)`,
        );
      }
    }
  });
}

Deno.test("PdfBuilder: newPage() throws on continuous paper after first page", async () => {
  const builder = await PdfBuilder.create({ orientation: "portrait", paperFormat: "80mm" });
  builder.newPage();
  let threw = false;
  try {
    builder.newPage();
  } catch (_e) {
    threw = true;
  }
  assertEquals(threw, true, "second newPage() on continuous media must throw");
});
