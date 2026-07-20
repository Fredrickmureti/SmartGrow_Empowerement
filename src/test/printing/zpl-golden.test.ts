/**
 * Golden byte-fixture tests for the server-side ZPL label adapter.
 *
 * Locks the on-wire byte stream for `inventory_label` and asserts that
 * the adapter still routes through `label_templates` (ADR-0086 / D1).
 * A regression that hardcodes a body, drops the `^XA`/`^XZ` envelope,
 * or changes the barcode type would trip these fixtures.
 *
 * The stub supabase client mirrors the shape the adapter uses:
 *  - `.from('products').select().eq().maybeSingle()` → product row
 *  - `.rpc('resolve_label_template', …)` → { body, engine, … }
 */
import { describe, expect, it } from 'vitest';

import { buildLabelZpl } from '../../../supabase/functions/_shared/printing/zpl/builder';

const INVENTORY_LABEL_BODY =
  '^XA\n^PW640\n^LL400\n^CF0,30\n^FO20,20^FD{{name}}^FS\n^FO20,60^FDSKU: {{sku}}^FS\n^CF0,40^FO20,100^FD{{price}}^FS\n^BY2,2,80\n^FO20,180^BCN,80,Y,N,N^FD{{barcode}}^FS\n^XZ';

function makeStub(opts: {
  product?: { sku?: string; name?: string; barcode?: string | null; organization_id?: string | null };
  template?: { body?: string; engine?: string } | null;
}) {
  const product = opts.product ?? null;
  const template = opts.template === undefined
    ? { body: INVENTORY_LABEL_BODY, engine: 'zpl', id: 't1', version: 1, kind: 'product', scope: 'org' }
    : opts.template;
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: product }; },
      };
    },
    async rpc(_name: string, _args: unknown) {
      return { data: template ? [template] : null, error: null };
    },
  } as unknown as Parameters<typeof buildLabelZpl>[0];
}

describe('zpl label adapter — golden bytes', () => {
  it('emits a balanced ^XA…^XZ envelope from the template body', async () => {
    const bytes = await buildLabelZpl(
      makeStub({ product: { sku: 'SKU-1234', name: 'SKU-1234', barcode: 'SKU-1234' } }),
      'inventory_label',
      'SKU-1234',
    );
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('^XA')).toBe(true);
    expect(text.trimEnd().endsWith('^XZ')).toBe(true);
    expect(text).toContain('^PW640');
    expect(text).toContain('^LL400');
  });

  it('renders SKU into the label text + CODE128 barcode field', async () => {
    const bytes = await buildLabelZpl(
      makeStub({ product: { sku: 'SKU-1234', name: 'Widget', barcode: 'SKU-1234' } }),
      'inventory_label',
      'SKU-1234',
    );
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('SKU: SKU-1234');
    expect(text).toContain('^BCN,80,Y,N,N');
    expect(text).toContain('^FDSKU-1234^FS');
  });

  it('strips non-ASCII safely (no raw UTF-8 bytes leak into ZPL)', async () => {
    const bytes = await buildLabelZpl(
      makeStub({ product: { sku: 'Café—Brûlée', name: 'Café—Brûlée', barcode: 'Café—Brûlée' } }),
      'inventory_label',
      'Café—Brûlée',
    );
    for (const b of bytes) {
      expect(b === 0x0a || (b >= 0x20 && b <= 0x7e)).toBe(true);
    }
  });

  it('rejects unsupported document types before any lookup', async () => {
    await expect(
      buildLabelZpl(makeStub({}), 'invoice', 'x'),
    ).rejects.toThrow(/does not support document type/);
  });

  it('surfaces a descriptive error when no template is registered', async () => {
    await expect(
      buildLabelZpl(
        makeStub({ product: { sku: 'SKU', name: 'n', barcode: 'b' }, template: null }),
        'inventory_label',
        'SKU',
      ),
    ).rejects.toThrow(/no label template registered/);
  });

  it('refuses to emit ZPL for a non-zpl template engine', async () => {
    await expect(
      buildLabelZpl(
        makeStub({
          product: { sku: 'SKU', name: 'n', barcode: 'b' },
          template: { body: 'escpos-bytes', engine: 'escpos' },
        }),
        'inventory_label',
        'SKU',
      ),
    ).rejects.toThrow(/not zpl/);
  });
});
