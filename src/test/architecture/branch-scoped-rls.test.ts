/**
 * Branch-scoped RLS arch test (Loop A1 follow-up).
 *
 * Asserts that on every multi-branch-sensitive table, the SELECT /
 * UPDATE / DELETE policies carry a branch predicate
 * (`can_access_branch` or `user_can_access_branch`).
 *
 * Backed by the `public.v_branch_scoped_policy_check` view created in
 * the 2026-06-17 migrations. Run against a connected Supabase project
 * (uses the publishable key); skipped automatically when env is absent
 * so unit-only test runs stay green.
 */
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;

const ENFORCED_CMDS = new Set(['SELECT', 'UPDATE', 'DELETE', 'ALL']);

describe('branch-scoped RLS arch test', () => {
  if (!url || !anon) {
    it.skip('skipped: SUPABASE env not configured', () => {});
    return;
  }
  const client = createClient(url, anon);

  it('every read/write policy on multi-branch tables carries a branch arm', async () => {
    const { data, error } = await client
      .from('v_branch_scoped_policy_check')
      .select('tablename, policyname, cmd, has_branch_arm');
    expect(error, error?.message).toBeNull();
    expect(Array.isArray(data)).toBe(true);

    const enforced = (data ?? []).filter((r: { cmd: string }) => ENFORCED_CMDS.has(r.cmd));
    const offenders = enforced.filter((r: { has_branch_arm: boolean }) => !r.has_branch_arm);

    if (offenders.length) {
      // Surface the list so CI shows which table:policy pair regressed.
      console.error('Policies missing branch arm:', offenders);
    }
    expect(offenders).toEqual([]);
  });
});
