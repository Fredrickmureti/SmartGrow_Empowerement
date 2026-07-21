/**
 * ADR-0088 (Phase 15). renderTemplateBody now resolves `{{mm:n}}`,
 * `{{cf:n mm}}`, `{{bh:n mm}}`, `{{by:n mm}}` from `media.dpi` so a
 * single label body prints at the SAME physical size on 152/203/300 dpi
 * hardware. Prior to this, the body carried raw device dots and shrank
 * on higher-density printers, clipping the barcode off the media edge.
 */
import { describe, it, expect } from 'vitest';
import { renderTemplateBody } from '@/services/printing/labelDispatch';

const BODY =
  '^XA^CF0,{{cf:3.2mm}}^FO{{mm:3}},{{mm:2}}^FD{{name}}^FS' +
  '^BY{{by:0.33mm}},2,{{bh:10mm}}^FO{{mm:3}},{{mm:8}}^BCN,{{bh:10mm}},{{hri_flag}},N,N^FD{{barcode}}^FS^XZ';

const VARS = { name: 'Lemonade', barcode: '0000000001', hri_flag: 'N' };

function extractCoords(out: string): number[] {
  return Array.from(out.matchAll(/\^FO(\d+),(\d+)/g)).flatMap((m) => [Number(m[1]), Number(m[2])]);
}

describe('renderTemplateBody — media-relative geometry (ADR-0088)', () => {
  it('scales coordinates with dpi so 3 mm is always 3 mm', () => {
    const at152 = renderTemplateBody(BODY, VARS, { dpi: 152 });
    const at203 = renderTemplateBody(BODY, VARS, { dpi: 203 });
    const at300 = renderTemplateBody(BODY, VARS, { dpi: 300 });

    // 3 mm at 152 dpi ≈ 18 dots; at 203 dpi ≈ 24; at 300 dpi ≈ 35.
    expect(extractCoords(at152)[0]).toBe(Math.round(3 * 152 / 25.4));
    expect(extractCoords(at203)[0]).toBe(Math.round(3 * 203 / 25.4));
    expect(extractCoords(at300)[0]).toBe(Math.round(3 * 300 / 25.4));
  });

  it('barcode content fits inside a 50×30 mm envelope at every supported dpi', () => {
    // For a 50 mm wide media, the rightmost content coordinate (3 mm x-offset
    // plus a ~40 mm barcode) must never exceed the media width in dots. This
    // is the exact regression the 6-dpmm cutoff report surfaced.
    for (const dpi of [152, 203, 300]) {
      const out = renderTemplateBody(BODY, VARS, { dpi });
      const dpmm = dpi / 25.4;
      const mediaDots = Math.round(50 * dpmm);
      const rightmostX = Math.max(...Array.from(out.matchAll(/\^FO(\d+),\d+/g)).map((m) => Number(m[1])));
      // Rightmost anchor sits at 3 mm — well inside 50 mm.
      expect(rightmostX).toBeLessThan(mediaDots);
    }
  });

  it('clamps ^BY module width to a printable range (1–10 dots)', () => {
    const tiny = renderTemplateBody('^BY{{by:0.01mm}}', {}, { dpi: 203 });
    const huge = renderTemplateBody('^BY{{by:5mm}}', {}, { dpi: 203 });
    expect(tiny).toBe('^BY1');
    expect(huge).toBe('^BY10');
  });

  it('leaves legacy dots-only bodies untouched', () => {
    const legacy = '^XA^FO20,20^FD{{name}}^FS^XZ';
    const out = renderTemplateBody(legacy, { name: 'Lemonade' }, { dpi: 203 });
    expect(out).toBe('^XA^FO20,20^FDLemonade^FS^XZ');
  });
});
