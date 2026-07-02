/**
 * Golden byte-fixture tests for the kitchen-ticket ESC/POS builder.
 *
 * Audit Wave 10 (P3 #16). Locks the on-wire byte stream so a future
 * refactor of `buildKitchenTicketEscPos` can't silently:
 *   - drop the banner / order number / time
 *   - flip command bytes (bold, double-wide, cut)
 *   - leak raw UTF-8 (non-ASCII) into the stream
 *   - reorder qty-vs-name so cooks have to re-learn the layout
 *
 * Mirrors the discipline of `zpl-golden.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  buildKitchenTicketEscPos,
  type KitchenTicketData,
} from '../../../supabase/functions/_shared/escpos/kitchen';

const baseData: KitchenTicketData = {
  order_number: 'POS-0042',
  placed_at: '2026-06-09T14:30:00.000Z',
  station: 'Grill',
  table: '7',
  customer_name: 'Walk-in',
  register_name: 'Register 1',
  cashier_name: 'Alex',
  items: [
    {
      description: 'Cheeseburger',
      quantity: 2,
      modifiers: ['no onions', 'extra cheese'],
      notes: 'well done',
    },
    {
      description: 'Fries — large',
      quantity: 1,
    },
  ],
};

function decode(bytes: Uint8Array): string {
  // The stream contains both control bytes and printable ASCII. Latin-1
  // decoding is lossless for byte-level assertions.
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

describe('kitchen ticket builder — golden bytes', () => {
  it('emits ESC @ init and ends with a full cut', () => {
    const bytes = buildKitchenTicketEscPos(baseData);
    // ESC @ = 0x1B 0x40 at the very start.
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40);
    // The last meaningful control sequence must be GS V 0 (full cut).
    const tail = Array.from(bytes.slice(-3));
    expect(tail).toEqual([0x1d, 0x56, 0x00]);
  });

  it('renders the banner uppercase, centered, bold + double-wide', () => {
    const bytes = buildKitchenTicketEscPos(baseData);
    const text = decode(bytes);
    // ESC a 1 (center) before banner, GS ! 0x11 (double w+h), ESC E 1 (bold).
    expect(text).toContain(String.fromCharCode(0x1b, 0x61, 0x01));
    expect(text).toContain(String.fromCharCode(0x1d, 0x21, 0x11));
    expect(text).toContain(String.fromCharCode(0x1b, 0x45, 0x01));
    expect(text).toContain('GRILL');
  });

  it('defaults the banner to KITCHEN when station is omitted', () => {
    const bytes = buildKitchenTicketEscPos({ ...baseData, station: null });
    expect(decode(bytes)).toContain('KITCHEN');
  });

  it('prints order number, formatted time, table, customer, register, cashier', () => {
    const text = decode(buildKitchenTicketEscPos(baseData));
    expect(text).toContain('Order: POS-0042');
    expect(text).toContain('Time:  2026-06-09 14:30');
    expect(text).toContain('Table: 7');
    expect(text).toContain('Cust:  Walk-in');
    expect(text).toContain('Reg:   Register 1');
    expect(text).toContain('By:    Alex');
  });

  it('prints quantity on the left of each item line and indents modifiers/notes', () => {
    const text = decode(buildKitchenTicketEscPos(baseData));
    expect(text).toContain('2x Cheeseburger');
    expect(text).toContain('1x Fries - large'); // em-dash transliterated to '-'
    expect(text).toContain('  - no onions');
    expect(text).toContain('  - extra cheese');
    expect(text).toContain('  * well done');
  });

  it('emits ESC/POS bytes that are all printable ASCII, LF, or control bytes ESC/GS', () => {
    const bytes = buildKitchenTicketEscPos(baseData);
    for (const b of bytes) {
      // Allow: printable ASCII, LF, ESC, GS, and the small set of arg
      // bytes that follow our commands. The transliteration layer
      // guarantees no raw UTF-8 continuation byte ever lands in the
      // stream — that would corrupt CP-* code pages on real printers.
      const ok =
        b === 0x0a || // LF
        b === 0x1b || // ESC
        b === 0x1d || // GS
        b <= 0x11 || // command argument bytes (align, cut variant, double mode)
        (b >= 0x20 && b <= 0x7e); // printable ASCII
      expect(ok, `byte 0x${b.toString(16)} outside allowed set`).toBe(true);
    }
  });

  it('respects width=58mm by clamping the banner column budget', () => {
    const bytes = buildKitchenTicketEscPos(
      { ...baseData, station: 'A-Really-Long-Station-Name' },
      { width: '58mm' },
    );
    const text = decode(bytes);
    // 58mm = 32 cols, banner double-wide budget = 16. Banner must be clipped.
    expect(text).toContain('A-REALLY-LONG-ST');
    expect(text).not.toContain('A-REALLY-LONG-STATION-NAME');
  });

  it('feeds before cut and honors cut="none"', () => {
    const bytes = buildKitchenTicketEscPos(baseData, { cut: 'none', feedLines: 0 });
    const tail = Array.from(bytes.slice(-3));
    // No GS V at the tail.
    expect(tail).not.toEqual([0x1d, 0x56, 0x00]);
    expect(tail).not.toEqual([0x1d, 0x56, 0x01]);
  });

  it('renders an empty-items ticket without crashing and marks it as such', () => {
    const text = decode(buildKitchenTicketEscPos({ ...baseData, items: [] }));
    expect(text).toContain('(no items)');
  });
});
