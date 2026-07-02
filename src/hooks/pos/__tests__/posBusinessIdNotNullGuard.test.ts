/**
 * POS multi-entity guard: every POS sub-table must have a NON-NULL business_id
 * column in the generated Supabase types. If a future migration drops or
 * relaxes the constraint, the generated `Insert` type for that table will stop
 * requiring `business_id`, and this test will fail.
 *
 * This is a static type-shape check — it runs in TS, not against the DB.
 */
import { describe, expect, it } from 'vitest';
import type { Database } from '@/integrations/supabase/types';

type Tables = Database['public']['Tables'];

// Compile-time assertion helper — `business_id` must exist and be required on Insert.
// Use optional-key detection instead of `undefined extends ...` so the guard remains
// valid even with `strictNullChecks` disabled in the app tsconfig.
type RequiresBusinessId<T> = 'business_id' extends keyof T
  ? {} extends Pick<T, 'business_id'>
    ? false
    : true
  : false;

describe('POS sub-tables require business_id', () => {
  it('pos_transactions.business_id is required on insert', () => {
    const v: RequiresBusinessId<Tables['pos_transactions']['Insert']> = true;
    expect(v).toBe(true);
  });
  it('pos_transaction_items.business_id is required on insert', () => {
    const v: RequiresBusinessId<Tables['pos_transaction_items']['Insert']> = true;
    expect(v).toBe(true);
  });
  it('pos_transaction_payments.business_id is required on insert', () => {
    const v: RequiresBusinessId<Tables['pos_transaction_payments']['Insert']> = true;
    expect(v).toBe(true);
  });
  it('pos_cashier_registers.business_id is required on insert', () => {
    const v: RequiresBusinessId<Tables['pos_cashier_registers']['Insert']> = true;
    expect(v).toBe(true);
  });
  it('pos_sessions.business_id is required on insert', () => {
    const v: RequiresBusinessId<Tables['pos_sessions']['Insert']> = true;
    expect(v).toBe(true);
  });
  it('pos_shifts.business_id is required on insert', () => {
    const v: RequiresBusinessId<Tables['pos_shifts']['Insert']> = true;
    expect(v).toBe(true);
  });
  it('pos_cashiers.business_id is required on insert', () => {
    const v: RequiresBusinessId<Tables['pos_cashiers']['Insert']> = true;
    expect(v).toBe(true);
  });
  it('pos_registers.business_id is required on insert', () => {
    const v: RequiresBusinessId<Tables['pos_registers']['Insert']> = true;
    expect(v).toBe(true);
  });
  it('pos_settings.business_id is required on insert', () => {
    const v: RequiresBusinessId<Tables['pos_settings']['Insert']> = true;
    expect(v).toBe(true);
  });
});
