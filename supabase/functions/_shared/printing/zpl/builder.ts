/**
 * ZPL/EPL label byte builder.
 *
 * Audit Wave 9d.7 (P3). Renders a minimal ZPL-II label payload for thermal
 * label printers (Zebra, generic) for the following document types:
 *   - `inventory_label`         (product label, vid/pid/SKU)
 *   - `shipping_label`          (TBD — falls back to a stub)
 *
 * The renderer is intentionally schema-light. A full template engine
 * (`label_templates` table mirroring `document_templates`) is tracked as a
 * follow-up; this stub keeps real ZPL flowing out of the label_printer
 * driver so the rest of the stack (queue, audit log, retry, status) can
 * exercise the path end-to-end today.
 *
 * Output:
 *   ZPL-II ASCII bytes (Uint8Array). Encoded UTF-8 → byte-equivalent for
 *   the ASCII subset every label printer accepts. Non-ASCII chars in the
 *   product name are stripped to a safe approximation.
 *
 * Reference:
 *   - Zebra ZPL II Programming Guide (ZPL = ^XA ... ^XZ envelope)
 *   - EPL2 fallback is intentionally out of scope here; EPL printers are
 *     <5% of the installed base and most accept ZPL via firmware setting.
 */

// Deno-style imports; runs inside Supabase Edge Functions.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

function asciiSafe(s: string | null | undefined, max = 32): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, max);
}

function zplLabel({ sku, name, barcode, price }: { sku: string; name: string; barcode: string; price?: string }): string {
  // 80 x 50 mm label at 203 dpi (≈ 640 x 400 dots).
  return [
    '^XA',                // start label
    '^PW640',             // print width
    '^LL400',             // label length
    '^CF0,30',            // font, height
    `^FO20,20^FD${asciiSafe(name, 36)}^FS`,
    `^FO20,60^FDSKU: ${asciiSafe(sku, 24)}^FS`,
    price ? `^CF0,40^FO20,100^FD${asciiSafe(price, 14)}^FS` : '',
    // CODE128 barcode
    '^BY2,2,80',
    `^FO20,180^BCN,80,Y,N,N^FD${asciiSafe(barcode || sku, 24)}^FS`,
    '^XZ',                // end label
  ].filter(Boolean).join('\n');
}

export async function buildLabelZpl(
  supabase: SupabaseClient,
  documentType: string,
  documentId: string,
): Promise<Uint8Array> {
  if (documentType !== 'inventory_label' && documentType !== 'shipping_label') {
    throw new Error(`ZPL renderer does not support document type "${documentType}"`);
  }

  let sku = documentId;
  let name = documentId;
  let barcode = documentId;
  let price: string | undefined;

  if (documentType === 'inventory_label') {
    try {
      const { data } = await supabase
        .from('products')
        .select('id, sku, name, barcode, retail_price, currency_code')
        .eq('id', documentId)
        .maybeSingle();
      if (data) {
        sku = (data as { sku?: string }).sku ?? sku;
        name = (data as { name?: string }).name ?? name;
        barcode = (data as { barcode?: string | null }).barcode ?? sku;
        const p = (data as { retail_price?: number | null; currency_code?: string }).retail_price;
        if (typeof p === 'number') {
          const cur = (data as { currency_code?: string }).currency_code ?? '';
          price = `${cur} ${p.toFixed(2)}`.trim();
        }
      }
    } catch {
      /* lookup failed — fall back to id-only stub label */
    }
  }

  const zpl = zplLabel({ sku, name, barcode, price });
  return new TextEncoder().encode(zpl);
}
