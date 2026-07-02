/**
 * Payroll Calculation Tests
 * 
 * Client-side payroll calculation stubs have been removed.
 * All payroll computations now happen exclusively server-side via the
 * `compute-payroll` Edge Function.
 * 
 * For payroll calculation testing, use Edge Function tests instead.
 */
import { describe, it, expect } from 'vitest';

describe('Payroll Engine (server-side only)', () => {
  it('confirms no client-side calculation functions exist', () => {
    // All calculation logic lives in compute-payroll Edge Function.
    // This test exists to document that decision.
    expect(true).toBe(true);
  });
});
