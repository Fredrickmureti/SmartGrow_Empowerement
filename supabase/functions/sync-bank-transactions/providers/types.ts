// Provider adapter contract for bank feeds.
//
// An adapter is TRANSPORT ONLY. It authenticates with the provider, fetches
// raw lines for a window and normalizes them into the canonical shape the
// ingestion engine (`bank_statement_import_batch`) accepts. It never writes
// to the database, never categorizes, never touches the ledger.

export interface BankProviderConfig {
  id: string;
  provider_code: string;
  provider_name: string;
  api_base_url: string | null;
  api_key_encrypted: string | null;
  api_secret_encrypted: string | null;
  merchant_code: string | null;
  public_key: string | null;
  private_key_encrypted: string | null;
  is_sandbox: boolean;
  config: Record<string, unknown>;
}

export interface FeedAccount {
  id: string;
  organization_id: string;
  name: string;
  bank_name: string | null;
  account_number: string | null;
  external_account_id: string | null;
  provider_id: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  sync_from_date: string | null;
  currency: string;
}

/** Canonical normalized bank line. Matches `bank_statement_import_batch` rows. */
export interface NormalizedFeedLine {
  external_transaction_id: string;
  transaction_date: string;
  posting_date: string | null;
  description: string | null;
  reference: string | null;
  /** Signed: negative for money out. */
  amount: number;
  balance_after: number | null;
  raw_data: Record<string, unknown>;
}

export interface FeedFetchResult {
  lines: NormalizedFeedLine[];
  /** Provider-reported closing balance, informational only — cash position is derived. */
  reportedBalance?: number | null;
}

export interface FeedWindow {
  from: string;
  to: string;
}

export type ProviderAdapter = (
  provider: BankProviderConfig,
  account: FeedAccount,
  window: FeedWindow,
) => Promise<FeedFetchResult>;

/** Typed transport failure so the run records why the feed broke. */
export class FeedError extends Error {
  constructor(
    readonly code:
      | 'BANK_FEED_AUTH'
      | 'BANK_FEED_TRANSPORT'
      | 'BANK_FEED_UNSUPPORTED_PROVIDER'
      | 'BANK_FEED_MALFORMED_RESPONSE',
    message: string,
  ) {
    super(message);
    this.name = 'FeedError';
  }
}
