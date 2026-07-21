/**
 * ADR-0089. Barcode identity policy: never encode a database UUID as a
 * scannable barcode. `resolveLabelBarcode` must prefer barcode → sku
 * and REFUSE (return null) when neither exists.
 */
import { describe, it, expect } from 'vitest';
import { resolveLabelBarcode } from '@/services/printing/labelBarcode';

describe('resolveLabelBarcode — enterprise barcode identity (ADR-0089)', () => {
  it('prefers product.barcode over sku', () => {
    const r = resolveLabelBarcode({ id: 'uuid', barcode: '5901234123457', sku: 'LMN-500' });
    expect(r).toEqual({ code: '5901234123457', hri: 'N', skuDisplay: 'LMN-500' });
  });

  it('falls back to sku when barcode is missing', () => {
    const r = resolveLabelBarcode({ id: 'uuid', barcode: null, sku: 'LMN-500' });
    expect(r?.code).toBe('LMN-500');
    expect(r?.skuDisplay).toBe('LMN-500');
  });

  it('REFUSES (returns null) when both barcode and sku are missing — never returns product.id', () => {
    const r = resolveLabelBarcode({ id: '2c31f-4d6b-4d48-8387-3de692b859eb' });
    expect(r).toBeNull();
  });

  it('treats whitespace-only sku as absent', () => {
    const r = resolveLabelBarcode({ id: 'uuid', barcode: null, sku: '   ' });
    expect(r).toBeNull();
  });

  it('rejects non-printable payloads', () => {
    const r = resolveLabelBarcode({ id: 'uuid', barcode: '\u0000\u0001', sku: null });
    expect(r).toBeNull();
  });

  it('never leaks skuDisplay from product.id when sku is absent', () => {
    const r = resolveLabelBarcode({ id: 'uuid-xxx', barcode: '5901234123457', sku: null });
    expect(r?.skuDisplay).toBe('');
  });
});
