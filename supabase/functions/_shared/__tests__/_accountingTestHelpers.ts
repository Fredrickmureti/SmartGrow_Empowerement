/**
 * Shared helpers for the accounting integration test suite (T-A … T-F).
 *
 * These tests prove the structural guarantees of the canonical posting /
 * voiding RPCs documented in `/docs/ACCOUNTING_AUDIT_FINAL.md`:
 *   - `post_journal_entry_atomic`  (single posting writer)
 *   - `void_journal_entry_atomic`  (single void writer, idempotent)
 *
 * Tests connect to the live project via the publishable key.
 *
 * IMPORTANT: tests REQUIRE a service-role key to bypass RLS for fixture setup
 * AND a `TEST_ORG_ID` pointing at a disposable org. If either is missing,
 * tests SKIP with a clear log line — they do NOT silently pass.
 */
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL") ?? "";
export const SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  "";
export const TEST_ORG_ID = Deno.env.get("TEST_ORG_ID") ?? "";

export function canRun(): { ok: boolean; reason?: string } {
  if (!SUPABASE_URL) return { ok: false, reason: "VITE_SUPABASE_URL missing" };
  if (!SERVICE_ROLE_KEY) {
    return {
      ok: false,
      reason:
        "SUPABASE_SERVICE_ROLE_KEY not set — accounting integration tests require service role.",
    };
  }
  if (!TEST_ORG_ID) {
    return {
      ok: false,
      reason: "TEST_ORG_ID env var not set — accounting tests need a disposable test org id.",
    };
  }
  return { ok: true };
}

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Create a temporary asset + revenue account pair on the test org.
 * Returns ids and a cleanup function.
 */
export async function seedAccounts(
  admin: SupabaseClient,
  orgId: string,
  tag: string,
): Promise<{ debitId: string; creditId: string; cleanup: () => Promise<void> }> {
  const stamp = Date.now().toString().slice(-6);
  const debit = await admin
    .from("accounts")
    .insert({
      organization_id: orgId,
      code: `T-DR-${stamp}-${tag}`,
      name: `Test DR ${tag}`,
      account_type: "asset",
    })
    .select("id")
    .single();
  if (debit.error) throw debit.error;

  const credit = await admin
    .from("accounts")
    .insert({
      organization_id: orgId,
      code: `T-CR-${stamp}-${tag}`,
      name: `Test CR ${tag}`,
      account_type: "revenue",
    })
    .select("id")
    .single();
  if (credit.error) throw credit.error;

  return {
    debitId: debit.data.id,
    creditId: credit.data.id,
    cleanup: async () => {
      await admin.from("accounts").delete().eq("id", debit.data.id);
      await admin.from("accounts").delete().eq("id", credit.data.id);
    },
  };
}

export async function getBalance(
  admin: SupabaseClient,
  accountId: string,
): Promise<number> {
  const { data, error } = await admin
    .from("accounts")
    .select("current_balance")
    .eq("id", accountId)
    .single();
  if (error) throw error;
  return Number(data?.current_balance ?? 0);
}

export interface PostArgs {
  orgId: string;
  debitId: string;
  creditId: string;
  amount: number;
  sourceType?: string;
  sourceId?: string;
  sourceSubtype?: string | null;
  description?: string;
}

export async function postJE(
  admin: SupabaseClient,
  args: PostArgs,
): Promise<string> {
  const { data, error } = await admin.rpc("post_journal_entry_atomic", {
    _organization_id: args.orgId,
    _entry_date: new Date().toISOString().split("T")[0],
    _description: args.description ?? `test post ${Date.now()}`,
    _source_type: args.sourceType ?? "test",
    _source_id: args.sourceId ?? crypto.randomUUID(),
    _source_subtype: args.sourceSubtype ?? null,
    _entry_number: null,
    _reference_number: null,
    _business_id: null,
    _user_id: null,
    _lines: [
      {
        account_id: args.debitId,
        debit: args.amount,
        credit: 0,
        description: "test DR",
      },
      {
        account_id: args.creditId,
        debit: 0,
        credit: args.amount,
        description: "test CR",
      },
    ],
    _auto_post: true,
    _idempotency_key: null,
    _metadata: null,
  } as any);
  if (error) throw error;
  return data as string;
}
