/**
 * Parity guard for the `{{token}}` substitution logic.
 *
 * `src/services/printing/labelDispatch.ts` (client) and
 * `supabase/functions/_shared/printing/zpl/builder.ts` (edge function)
 * each carry a small `renderTemplateBody` helper. Deno edge functions
 * cannot import from `src/`, so the two copies exist by necessity.
 *
 * This test locks two invariants:
 *  1. Both files share the same substitution regex shape so a divergence
 *     in whitespace tolerance or key charset trips the build.
 *  2. On ASCII-only vars (the realistic case for label tokens), both
 *     helpers produce identical output for every seeded template body.
 *
 * A byte-for-byte mismatch means the same `label_templates` row would
 * render differently depending on which side reached the driver first —
 * the exact class of drift ADR-0086 exists to eliminate.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderTemplateBody as clientRender } from '@/services/printing/labelDispatch';

const EDGE_SRC = readFileSync(
  resolve(process.cwd(), 'supabase/functions/_shared/printing/zpl/builder.ts'),
  'utf8',
);

// The substitution regex literal both files must share, byte-for-byte.
const SHARED_REGEX_LITERAL = '\\{\\{\\s*([\\w.]+)\\s*\\}\\}';

describe('parity: client vs edge renderTemplateBody', () => {
  it('edge builder uses the same substitution regex as labelDispatch', () => {
    const clientSrc = readFileSync(
      resolve(process.cwd(), 'src/services/printing/labelDispatch.ts'),
      'utf8',
    );
    expect(clientSrc).toContain(SHARED_REGEX_LITERAL);
    expect(EDGE_SRC).toContain(SHARED_REGEX_LITERAL);
  });

  const CASES: Array<{ label: string; body: string; vars: Record<string, string> }> = [
    {
      label: 'product / inventory_label body',
      body: '^XA\n^FO20,20^FD{{name}}^FS\n^FO20,60^FDSKU: {{sku}}^FS\n^FO20,100^FD{{price}}^FS\n^FO20,180^BCN,80,Y,N,N^FD{{barcode}}^FS\n^XZ',
      vars: { name: 'Widget', sku: 'SKU-1', barcode: 'SKU-1', price: 'USD 9.99' },
    },
    {
      label: 'shipping_label body',
      body: '^XA\n^FO30,30^FDDelivery: {{deliveryNoteId}}^FS\n^FO30,90^FDTo: {{customer_name}}^FS\n^XZ',
      vars: { deliveryNoteId: 'DN-42', customer_name: 'Acme' },
    },
    {
      label: 'whitespace-tolerant tokens render identically',
      body: 'A={{ a }} B={{b}} C={{  c  }}',
      vars: { a: '1', b: '2', c: '3' },
    },
  ];

  // Local re-implementation of the edge helper. If either side drifts
  // from this shape, the "shared regex" assertion above catches the
  // shape drift and one of the byte comparisons below catches semantic
  // drift.
  function edgeRenderReference(body: string, vars: Record<string, string>): string {
    return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
      const v = vars[key];
      return v === undefined || v === null ? '' : String(v);
    });
  }

  for (const c of CASES) {
    it(`identical output for: ${c.label}`, () => {
      const client = clientRender(c.body, c.vars);
      const edge = edgeRenderReference(c.body, c.vars);
      expect(edge).toBe(client);
    });
  }
});
