/**
 * Track H-Scan / H4b — contract tests for the tagged useResolveBarcode.
 *
 * Covers the four guarantees the renderer-side resolve pipeline owes to
 * `POSTerminal.handleScan` so the "barcode invalid / valid / invalid"
 * flicker reported on the web POS phone scanner cannot regress:
 *
 *   1. `hit`   — RPC returned a row → tagged `kind: 'hit'`.
 *   2. `miss`  — RPC returned [] → tagged `kind: 'miss'`, cached for ≤5s.
 *   3. `error` — RPC threw / returned `error` → tagged `kind: 'error'`,
 *                NEVER cached, surfaces one auto-retry before the user.
 *   4. Single-flight — two concurrent identical resolves share one RPC.
 *
 * Mocks `supabase.rpc` so the test runs in jsdom without network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import { useResolveBarcode } from '@/hooks/pos/useResolveBarcode';

const HIT_ROW = {
  product_id: 'p1',
  name: 'Test Product',
  sku: 'SKU-1',
  selling_price: 100,
  cost_price: 60,
  tax_rate: 16,
  tax_rate_id: 'tr-1',
  tax_rate_name: 'VAT 16%',
  etims_tax_code: 'A',
  category_id: 'c1',
  category_name: 'Cat',
  branch_on_hand: 5,
  matched_kind: 'gtin',
  matched_code: '5901234123457',
  matched_rule_kind: null,
  scan_quantity: 1,
  scan_weight: null,
  embedded_price: null,
  is_weighted: false,
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function mountResolver() {
  const client = new QueryClient();
  return renderHook(() => useResolveBarcode('biz-1', 'branch-1'), {
    wrapper: wrapper(client),
  });
}

describe('useResolveBarcode tagged contract (Track H-Scan / H4b)', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('returns { kind: "hit", row } when the RPC returns a row', async () => {
    rpcMock.mockResolvedValueOnce({ data: [HIT_ROW], error: null });
    const { result } = mountResolver();
    let r: unknown;
    await act(async () => { r = await result.current.resolveTagged('5901234123457'); });
    expect((r as { kind: string }).kind).toBe('hit');
    if ((r as { kind: string }).kind === 'hit') {
      const hit = r as { kind: 'hit'; row: { productId: string; sellingPrice: number } };
      expect(hit.row.productId).toBe('p1');
      expect(hit.row.sellingPrice).toBe(100);
    }
  });

  it('returns { kind: "miss" } when the RPC returns []', async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    const { result } = mountResolver();
    let r: unknown;
    await act(async () => { r = await result.current.resolveTagged('does-not-exist'); });
    expect((r as { kind: string }).kind).toBe('miss');
  });

  it('returns { kind: "error" } when the RPC returns an error AFTER one retry', async () => {
    // Both attempts fail → caller sees error.
    rpcMock.mockResolvedValue({ data: null, error: { message: 'network blip' } });
    const { result } = mountResolver();
    let r: unknown;
    await act(async () => { r = await result.current.resolveTagged('xx'); });
    expect((r as { kind: string }).kind).toBe('error');
    // One retry was attempted → 2 total calls.
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('auto-retries once on error and surfaces a hit if the retry succeeds', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: 'transient' } })
      .mockResolvedValueOnce({ data: [HIT_ROW], error: null });
    const { result } = mountResolver();
    let r: unknown;
    await act(async () => { r = await result.current.resolveTagged('5901234123457'); });
    expect((r as { kind: string }).kind).toBe('hit');
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('never caches an error result — a subsequent call re-issues the RPC', async () => {
    // First call: 2× failure → error. Second call: 1× success → hit.
    rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: 'blip' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'blip' } })
      .mockResolvedValueOnce({ data: [HIT_ROW], error: null });
    const { result } = mountResolver();
    let r1: unknown; let r2: unknown;
    await act(async () => { r1 = await result.current.resolveTagged('123'); });
    await act(async () => { r2 = await result.current.resolveTagged('123'); });
    expect((r1 as { kind: string }).kind).toBe('error');
    expect((r2 as { kind: string }).kind).toBe('hit');
    expect(rpcMock).toHaveBeenCalledTimes(3); // 2 (error+retry) + 1 (success)
  });

  it('caches hits — a repeated scan does not re-issue the RPC', async () => {
    rpcMock.mockResolvedValueOnce({ data: [HIT_ROW], error: null });
    const { result } = mountResolver();
    await act(async () => { await result.current.resolveTagged('123'); });
    await act(async () => { await result.current.resolveTagged('123'); });
    await act(async () => { await result.current.resolveTagged('123'); });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('caches misses for the short TTL only (still served from cache within 5s)', async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    const { result } = mountResolver();
    await act(async () => { await result.current.resolveTagged('nope'); });
    await act(async () => { await result.current.resolveTagged('nope'); });
    // Still inside TTL — second scan served from cache.
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('single-flights two concurrent identical resolves into ONE RPC call', async () => {
    let resolveOnce: (v: { data: unknown; error: null }) => void = () => {};
    rpcMock.mockImplementationOnce(
      () => new Promise((res) => { resolveOnce = res; }),
    );
    const { result } = mountResolver();
    let a: unknown; let b: unknown;
    await act(async () => {
      // Fire both before the first one resolves.
      const pa = result.current.resolveTagged('5901234123457');
      const pb = result.current.resolveTagged('5901234123457');
      resolveOnce({ data: [HIT_ROW], error: null });
      [a, b] = await Promise.all([pa, pb]);
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect((a as { kind: string }).kind).toBe('hit');
    expect((b as { kind: string }).kind).toBe('hit');
  });

  it('back-compat resolve() returns null for both miss and error', async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    const { result } = mountResolver();
    let v: unknown;
    await act(async () => { v = await result.current.resolve('nope'); });
    expect(v).toBeNull();

    rpcMock.mockResolvedValue({ data: null, error: { message: 'err' } });
    let v2: unknown;
    await act(async () => { v2 = await result.current.resolve('boom'); });
    expect(v2).toBeNull();
  });
});
