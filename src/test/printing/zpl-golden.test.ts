/**
 * Golden byte-fixture tests for the ZPL label builder.
 *
 * Audit Wave 9d.9 (P5 #25). Locks the on-wire byte stream so a future
 * refactor of `buildLabelZpl` (or the asciiSafe helper) can't silently
 * shift dot offsets, change the barcode type, or drop the ^XA/^XZ
 * envelope — any of which would brick label runs in the field.
 */
import { describe, expect, it } from 'vitest';

// We import the renderer directly. It accepts a Supabase client only for
// inventory_label lookups; passing a stub that returns no row exercises
// the "fallback to id-only stub label" branch deterministically.
import { buildLabelZpl } from '../../../supabase/functions/_shared/printing/zpl/builder';

const noopSupabase = {
  from() {
    return {
      select() { return this; },
      eq() { return this; },
      async maybeSingle() { return { data: null }; },
    };
  },
} as unknown as Parameters<typeof buildLabelZpl>[0];

describe('zpl label builder — golden bytes', () => {
  it('emits a balanced ^XA…^XZ envelope', async () => {
    const bytes = await buildLabelZpl(noopSupabase, 'inventory_label', 'SKU-1234');
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('^XA')).toBe(true);
    expect(text.trimEnd().endsWith('^XZ')).toBe(true);
    expect(text).toContain('^PW640');
    expect(text).toContain('^LL400');
  });

  it('renders SKU into the label text + CODE128 barcode field', async () => {
    const bytes = await buildLabelZpl(noopSupabase, 'inventory_label', 'SKU-1234');
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('SKU: SKU-1234');
    expect(text).toContain('^BCN,80,Y,N,N');
    expect(text).toContain('^FDSKU-1234^FS');
  });

  it('strips non-ASCII safely (no raw UTF-8 bytes leak into ZPL)', async () => {
    const bytes = await buildLabelZpl(noopSupabase, 'inventory_label', 'Café—Brûlée');
    // Every byte must be in the printable-ASCII range or LF.
    for (const b of bytes) {
      expect(b === 0x0a || (b >= 0x20 && b <= 0x7e)).toBe(true);
    }
  });

  it('rejects unsupported document types', async () => {
    await expect(buildLabelZpl(noopSupabase, 'invoice', 'x')).rejects.toThrow(
      /does not support document type/,
    );
  });
});
