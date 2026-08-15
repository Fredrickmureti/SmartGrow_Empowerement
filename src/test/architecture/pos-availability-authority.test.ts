/**
 * Phase 3 guard — POS stock availability authority.
 *
 * The browser is never authoritative for stock. Checkout verification must
 * go through the register-scoped server RPCs, and the POS realtime signal
 * must be the branch-grained `stock_quants` table, never the company-wide
 * `products.stock_quantity` aggregate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const SYNC = 'src/hooks/pos/usePOSStockSync.ts';

describe('POS availability authority', () => {
  it('cart verification is one batched, register-scoped server call', () => {
    const src = read(SYNC);
    expect(src).toMatch(/get_available_pos_stock_for_register_batch/);
    // No per-line sequential availability loop.
    expect(src).not.toMatch(/for\s*\(const item of items\)[\s\S]{0,200}await checkAvailability/);
  });

  it('cart verification fails closed when the authority is unreachable', () => {
    const src = read(SYNC);
    expect(src).toMatch(/if \(error\)[\s\S]{0,200}valid: false/);
  });

  it('POS realtime listens to branch-grained stock_quants, not products', () => {
    const src = read(SYNC);
    expect(src).toMatch(/table: "stock_quants"/);
    expect(src).toMatch(/filter: `business_id=eq\.\$\{businessId\}`/);
    expect(src).not.toMatch(/table: "products"/);
    expect(src).not.toMatch(/\.stock_quantity/);
  });

  it('the cached grid quantity is only ever an advisory hint', () => {
    const src = read('src/hooks/pos/usePOSProducts.ts');
    expect(src).toMatch(/hasStockHint/);
    expect(src).not.toMatch(/\bconst hasStock\b/);
  });
});
