// Jenga / Finserve (Kenya) transport adapter.
//
// Kenya-specific concerns (RSA request signing, KE country code, full vs mini
// statement fallback) live HERE and nowhere else. The rest of the feed
// pipeline is provider-agnostic.

import { encode as base64Encode } from 'https://deno.land/std@0.208.0/encoding/base64.ts';
import {
  BankProviderConfig,
  FeedAccount,
  FeedError,
  FeedFetchResult,
  FeedWindow,
  NormalizedFeedLine,
} from './types.ts';

const COUNTRY_CODE = 'KE';

interface JengaTransaction {
  reference?: string;
  date?: string;
  description?: string;
  amount?: string | number;
  serial?: string;
  chequeNumber?: string;
  postedDateTime?: string;
  type?: string;
  runningBalance?: { currency?: string; amount?: number };
}

function baseUrl(provider: BankProviderConfig): string {
  return provider.is_sandbox ? 'https://uat.finserve.africa' : 'https://api.finserve.africa';
}

function accountNumberOf(account: FeedAccount): string {
  return account.account_number || account.external_account_id || '';
}

async function sign(data: string, privateKey: string | null): Promise<string> {
  if (!privateKey) return '';
  const pem = privateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  try {
    const binaryKey = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(data),
    );
    return base64Encode(new Uint8Array(signature));
  } catch (error) {
    throw new FeedError(
      'BANK_FEED_AUTH',
      `Jenga request signing failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function accessToken(provider: BankProviderConfig): Promise<string> {
  const url = `${baseUrl(provider)}/authentication/api/v3/authenticate/merchant`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Key': provider.api_key_encrypted || '' },
    body: JSON.stringify({
      merchantCode: provider.merchant_code,
      consumerSecret: provider.api_secret_encrypted,
    }),
  });

  if (!response.ok) {
    throw new FeedError(
      'BANK_FEED_AUTH',
      `Jenga authentication failed [${response.status}]: ${await response.text()}`,
    );
  }

  const data = await response.json();
  const token = data.accessToken || data.access_token;
  if (!token) throw new FeedError('BANK_FEED_AUTH', 'Jenga returned no access token');
  return token;
}

function normalize(tx: JengaTransaction, fallbackSeq: number): NormalizedFeedLine {
  const magnitude = Math.abs(Number(tx.amount ?? 0));
  const signed = tx.type?.toLowerCase() === 'debit' ? -magnitude : magnitude;
  const date = tx.date || tx.postedDateTime || null;
  return {
    // Identity must be stable across runs: never seed it with Date.now().
    external_transaction_id:
      tx.reference || tx.serial || tx.chequeNumber ||
      `jenga:${date ?? 'nodate'}:${magnitude}:${fallbackSeq}`,
    transaction_date: (date ?? '').slice(0, 10),
    posting_date: (tx.postedDateTime || date || '').slice(0, 10) || null,
    description: tx.description ?? null,
    reference: tx.reference ?? null,
    amount: signed,
    balance_after: tx.runningBalance?.amount ?? null,
    raw_data: tx as unknown as Record<string, unknown>,
  };
}

async function reportedBalance(
  provider: BankProviderConfig,
  account: FeedAccount,
  token: string,
): Promise<number | null> {
  const acct = accountNumberOf(account);
  try {
    const signature = await sign(`${COUNTRY_CODE}${acct}`, provider.private_key_encrypted);
    const response = await fetch(
      `${baseUrl(provider)}/v3-apis/account-api/v3.0/accounts/balances/${COUNTRY_CODE}/${acct}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          signature,
        },
      },
    );
    if (!response.ok) {
      console.error(`[Jenga] balance [${response.status}]: ${await response.text()}`);
      return null;
    }
    const data = await response.json();
    if (Array.isArray(data.data?.balances)) {
      const available = data.data.balances.find((b: { type?: string }) => b.type === 'Available');
      return available?.amount ?? data.data.balances[0]?.amount ?? null;
    }
    return data.balance ?? data.availableBalance ?? null;
  } catch (error) {
    console.error('[Jenga] balance fetch failed:', error);
    return null;
  }
}

async function miniStatement(
  provider: BankProviderConfig,
  account: FeedAccount,
  token: string,
): Promise<NormalizedFeedLine[]> {
  const acct = accountNumberOf(account);
  const signature = await sign(`${COUNTRY_CODE}${acct}`, provider.private_key_encrypted);
  const response = await fetch(
    `${baseUrl(provider)}/v3-apis/account-api/v3.0/accounts/miniStatement/${COUNTRY_CODE}/${acct}`,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', signature } },
  );

  if (!response.ok) {
    throw new FeedError(
      'BANK_FEED_TRANSPORT',
      `Jenga mini statement failed [${response.status}]: ${await response.text()}`,
    );
  }

  const data = await response.json();
  const rows: JengaTransaction[] = data.data?.transactions || data.transactions || [];
  return rows.map(normalize);
}

export const jengaAdapter = async (
  provider: BankProviderConfig,
  account: FeedAccount,
  window: FeedWindow,
): Promise<FeedFetchResult> => {
  const token = await accessToken(provider);
  const acct = accountNumberOf(account);
  const balance = await reportedBalance(provider, account, token);
  const signature = await sign(
    `${acct}${COUNTRY_CODE}${window.to}`,
    provider.private_key_encrypted,
  );

  const response = await fetch(
    `${baseUrl(provider)}/v3-apis/account-api/v3.0/accounts/fullStatement`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', signature },
      body: JSON.stringify({
        countryCode: COUNTRY_CODE,
        accountNumber: acct,
        fromDate: window.from,
        toDate: window.to,
      }),
    },
  );

  if (!response.ok) {
    console.error(`[Jenga] full statement [${response.status}]: ${await response.text()}`);
    // Documented provider fallback: the mini statement covers the recent window.
    return { lines: await miniStatement(provider, account, token), reportedBalance: balance };
  }

  const data = await response.json();
  const rows: JengaTransaction[] = data.data?.transactions || data.transactions || [];
  return { lines: rows.map(normalize), reportedBalance: balance };
};
