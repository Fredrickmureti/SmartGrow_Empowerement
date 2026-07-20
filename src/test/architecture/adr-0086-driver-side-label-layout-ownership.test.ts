/**
 * Architecture guard — ADR-0086 / D6.
 *
 * The device-side label drivers under `electron/hardware/drivers/` are
 * pure transports. Label LAYOUT (fields, coordinates, barcode/QR
 * placement, font selection) belongs in `label_templates` and is
 * resolved upstream by `src/services/printing/labelDispatch.ts` (client)
 * or `supabase/functions/_shared/printing/zpl/builder.ts` (server). If a
 * driver ever re-adopts a `LabelSpec` / `renderSpec` shape or hardcodes
 * `^FO`/`^FD`/`A<x>,<y>` opcodes we regress to the pre-D6 topology
 * (two sources of truth for label bytes).
 *
 * Envelope framing (`^XA`/`^XZ`) and transport commands
 * (`^MD`, `^PR`, `^PW`, `^LL`) are permitted: they configure the wire
 * and the printer, not layout.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DRIVER_DIR = resolve(process.cwd(), 'electron/hardware/drivers');

function driverFiles(): string[] {
  return readdirSync(DRIVER_DIR)
    .filter((f) => /Label.*Driver\.ts$/.test(f))
    .map((f) => join(DRIVER_DIR, f));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('architecture (ADR-0086/D6): device-side label drivers own no layout', () => {
  const files = driverFiles();

  it('discovers at least the Zpl and Epl label drivers', () => {
    const names = files.map((p) => p.split('/').pop());
    expect(names).toEqual(expect.arrayContaining(['ZplLabelDriver.ts', 'EplLabelDriver.ts']));
  });

  for (const file of files) {
    const name = file.split('/').pop()!;
    const code = stripComments(readFileSync(file, 'utf8'));

    it(`${name}: contains no ZPL layout opcodes (^FO/^FD/^FS/^BC/^BQ/^CF)`, () => {
      expect(code).not.toMatch(/\^FO/);
      expect(code).not.toMatch(/\^FD/);
      expect(code).not.toMatch(/\^FS/);
      expect(code).not.toMatch(/\^BC/);
      expect(code).not.toMatch(/\^BQ/);
      expect(code).not.toMatch(/\^CF/);
    });

    it(`${name}: contains no EPL text/barcode opcodes (A<x>,<y> / B<x>,<y>)`, () => {
      // EPL opcodes are single-letter followed by comma-separated fields.
      // Match on a source-code shape (backtick or string literal starting
      // with `A` or `B` followed by a digit + comma).
      expect(code).not.toMatch(/["'`]A\d+,\d+/);
      expect(code).not.toMatch(/["'`]B\d+,\d+/);
    });

    it(`${name}: does not declare LabelSpec or renderSpec`, () => {
      expect(code).not.toMatch(/\bLabelSpec\b/);
      expect(code).not.toMatch(/\brenderSpec\b/);
    });
  }
});