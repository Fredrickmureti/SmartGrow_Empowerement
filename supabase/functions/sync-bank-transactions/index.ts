// Bank feed sync — TRANSPORT ONLY.
//
// This function owns nothing accounting-shaped. Its whole job is:
//   1. open a run through `bank_feed_run_start` (the seam resolves/creates the
//      connection, refuses a second in-flight run and refuses a dead consent),
//   2. ask the provider adapter for normalized lines in the run window,
//   3. hand those lines to `bank_statement_import_batch` — the single ingestion
//      engine, which owns dedup identity, the lifecycle and fiscal-period
//      gates, deterministic rule categorization, statement bookkeeping and the
//      business event,
//   4. close the run with `bank_feed_run_finish`, or record why it broke with
//      `bank_feed_run_fail`.
//
// Explicitly NOT here: categorization rules (the database owns them), cash
// balances (derived — ADR-0141, `bank_account_positions`), any write to
// `bank_transactions`, and any provider-specific logic (that lives in
// `providers/*`).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveAdapter } from './providers/index.ts';
import {
  BankProviderConfig,
  FeedAccount,
  FeedError,
  FeedWindow,
  NormalizedFeedLine,
} from './providers/types.ts';
import { annotateLines, type AdvisoryScope } from './aiAdvisory.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const DEFAULT_LOOKBACK_DAYS = 30;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function resolveWindow(
  runFrom: string | null,
  runTo: string | null,
  syncFrom: string | null,
): FeedWindow {
  const to = runTo ?? isoDay(new Date());
  const from =
    runFrom ??
    syncFrom ??
    isoDay(new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));
  return { from, to };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let runId: string | null = null;

  try {
    const body = await req.json().catch(() => ({}));
    const bankAccountId: string | undefined = body?.bank_account_id;
    const organizationId: string | undefined = body?.organization_id;
    const triggerSource: string = body?.trigger_source ?? 'manual';

    if (!bankAccountId || !organizationId) {
      return json({ error: 'bank_account_id and organization_id are required' }, 400);
    }

    // ─── Scope is owned by the row, not by the caller ───
    // The tenant tuple used for entitlement and for any AI attribution comes
    // from the bank account itself. A body `organization_id` that disagrees is
    // refused rather than silently trusted (it would let a member of tenant A
    // spend/entitle against tenant B's account).
    const { data: scopeRow, error: scopeError } = await supabase
      .from('bank_accounts')
      .select('organization_id, business_id, branch_id')
      .eq('id', bankAccountId)
      .maybeSingle();

    if (scopeError || !scopeRow) {
      return json({ error: 'Bank account not found' }, 404);
    }
    if (scopeRow.organization_id !== organizationId) {
      return json(
        { error: 'This bank account belongs to a different organization.', code: 'SCOPE_MISMATCH' },
        403,
      );
    }

    const advisoryScope: AdvisoryScope = {
      organizationId: scopeRow.organization_id,
      businessId: scopeRow.business_id ?? null,
      branchId: scopeRow.branch_id ?? null,
      // Cron runs have no user: attribute the spend to the tenant only.
      userId: triggerSource === 'manual' ? (body?.user_id ?? null) : null,
      appKey: 'banking',
    };

    // ─── Subscription entitlement check ───
    const { checkAppEntitlement, entitlementDeniedResponse } = await import(
      '../_shared/entitlementCheck.ts'
    );
    const entResult = await checkAppEntitlement(supabase, organizationId, 'banking');
    if (!entResult.allowed) return entitlementDeniedResponse(entResult, corsHeaders);

    // ── 1. Open the run. The seam owns connection identity and concurrency. ──
    const { data: startData, error: startError } = await supabase.rpc('bank_feed_run_start', {
      _bank_account_id: bankAccountId,
      _window_from: body?.window_from ?? null,
      _window_to: body?.window_to ?? null,
      _trigger_source: triggerSource,
      _user_id: body?.user_id ?? null,
    });

    if (startError) {
      const message = startError.message ?? 'Failed to start bank feed run';
      if (message.includes('BANK_FEED_RUN_IN_FLIGHT')) {
        return json({ error: 'A sync is already running for this account.', code: 'BANK_FEED_RUN_IN_FLIGHT' }, 409);
      }
      if (message.includes('BANK_FEED_NEEDS_REAUTH')) {
        return json({ error: 'This bank connection needs to be re-authorised.', code: 'BANK_FEED_NEEDS_REAUTH' }, 409);
      }
      return json({ error: message }, 400);
    }

    const run = startData as {
      run_id: string;
      connection_id: string;
      provider_code: string | null;
      window_from: string | null;
      window_to: string | null;
    };
    runId = run.run_id;

    // ── 2. Fetch through the provider adapter. ──
    const { data: account, error: accountError } = await supabase
      .from('bank_accounts')
      .select('*, platform_bank_providers(*)')
      .eq('id', bankAccountId)
      .single();

    if (accountError || !account) {
      throw new FeedError('BANK_FEED_TRANSPORT', 'Bank account not found');
    }

    const provider = account.platform_bank_providers as BankProviderConfig | null;
    if (!provider) {
      throw new FeedError(
        'BANK_FEED_UNSUPPORTED_PROVIDER',
        'This bank account has no feed provider configured; import a statement instead.',
      );
    }

    const adapter = resolveAdapter(run.provider_code ?? provider.provider_code);
    const window = resolveWindow(run.window_from, run.window_to, account.sync_from_date ?? null);

    const feedAccount: FeedAccount = {
      id: account.id,
      organization_id: account.organization_id,
      name: account.name,
      bank_name: account.bank_name ?? null,
      account_number: account.account_number ?? null,
      external_account_id: account.external_account_id ?? null,
      provider_id: account.provider_id ?? null,
      access_token_encrypted: account.access_token_encrypted ?? null,
      refresh_token_encrypted: account.refresh_token_encrypted ?? null,
      sync_from_date: account.sync_from_date ?? null,
      currency: account.currency,
    };

    const fetched = await adapter(provider, feedAccount, window);
    const lines: NormalizedFeedLine[] = fetched.lines ?? [];

    // ── 3. Persist through the one ingestion engine. ──
    // Advisory AI hints only; `category` is left for the database rules.
    const advice = await annotateLines(supabase, lines, advisoryScope);

    let inserted = 0;
    let duplicates = 0;
    let rejected = 0;
    let statementId: string | null = null;

    if (lines.length > 0) {
      const rows = lines.map((line) => ({
        external_transaction_id: line.external_transaction_id,
        transaction_date: line.transaction_date,
        posting_date: line.posting_date,
        description: line.description,
        reference: line.reference,
        amount: line.amount,
        balance_after: line.balance_after,
        raw_data: line.raw_data,
        ...(advice.get(line.external_transaction_id) ?? {}),
      }));

      const { data: importResult, error: importError } = await supabase.rpc(
        'bank_statement_import_batch',
        {
          _bank_account_id: bankAccountId,
          _rows: rows,
          _statement: {
            file_name: `${run.provider_code ?? 'feed'} ${window.from}..${window.to}`,
            // Stable per (account, window, run): re-running a window updates the
            // same statement header instead of littering new ones.
            file_hash: `feed_${bankAccountId}_${window.from}_${window.to}`,
            file_format: 'provider_feed',
            // Provider-reported closing balance is evidence, not a stored balance.
            closing_balance: fetched.reportedBalance ?? null,
          },
          _source: `feed:${run.provider_code ?? 'unknown'}`,
        },
      );

      if (importError) {
        throw new FeedError(
          'BANK_FEED_TRANSPORT',
          `Ingestion refused the batch: ${importError.message}`,
        );
      }

      const result = importResult as {
        statement_id?: string;
        inserted?: number;
        duplicates?: number;
        rejected?: number;
      } | null;
      inserted = result?.inserted ?? 0;
      duplicates = result?.duplicates ?? 0;
      rejected = result?.rejected ?? 0;
      statementId = result?.statement_id ?? null;
    }

    // ── 4. Close the run. ──
    const { error: finishError } = await supabase.rpc('bank_feed_run_finish', {
      _run_id: runId,
      _fetched: lines.length,
      _inserted: inserted,
      _duplicates: duplicates,
      _rejected: rejected,
      _statement_id: statementId,
    });
    if (finishError) throw finishError;

    return json({
      success: true,
      run_id: runId,
      connection_id: run.connection_id,
      window,
      total_fetched: lines.length,
      new_transactions: inserted,
      duplicate_transactions: duplicates,
      rejected_transactions: rejected,
      statement_id: statementId,
      reported_balance: fetched.reportedBalance ?? null,
    });
  } catch (error) {
    const code =
      error instanceof FeedError ? error.code : 'BANK_FEED_TRANSPORT';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Sync] ${code}: ${message}`);

    if (runId) {
      // A failed run must never stay "running" — the connection state and the
      // failure counter are what make a broken feed observable.
      const { error: failError } = await supabase.rpc('bank_feed_run_fail', {
        _run_id: runId,
        _error_code: code,
        _error_message: message,
      });
      if (failError) console.error('[Sync] could not record failure:', failError.message);
    }

    const status = code === 'BANK_FEED_UNSUPPORTED_PROVIDER' ? 422 : code === 'BANK_FEED_AUTH' ? 401 : 502;
    return json({ error: message, code, run_id: runId }, status);
  }
});
