// Provider registry: `provider_code` → transport adapter.
//
// Every code present in `platform_bank_providers` must resolve here, either to
// a real adapter or to an explicit refusal. A missing entry is a configuration
// error, not a silent empty sync (which the old switch statement produced).

import { FeedError, ProviderAdapter } from './types.ts';
import { jengaAdapter } from './jenga.ts';

/** Codes that are known banks but have no transport implementation yet. */
const UNIMPLEMENTED = [
  'kcb_buni',
  'coop_connect',
  'ncba',
  'absa',
  'stanchart',
  'im_bank',
  'stanbic',
  'dtb_astra',
] as const;

/** `manual` is a file/manual-entry source, never a pull feed. */
const NOT_A_FEED = ['manual'] as const;

const ADAPTERS: Record<string, ProviderAdapter> = {
  jenga: jengaAdapter,
};

export function resolveAdapter(providerCode: string | null | undefined): ProviderAdapter {
  const code = (providerCode ?? '').trim().toLowerCase();

  if (!code) {
    throw new FeedError(
      'BANK_FEED_UNSUPPORTED_PROVIDER',
      'This bank account has no feed provider configured; import a statement instead.',
    );
  }

  const adapter = ADAPTERS[code];
  if (adapter) return adapter;

  if ((NOT_A_FEED as readonly string[]).includes(code)) {
    throw new FeedError(
      'BANK_FEED_UNSUPPORTED_PROVIDER',
      `"${code}" is a manual source: transactions arrive by statement import, not by feed sync.`,
    );
  }

  if ((UNIMPLEMENTED as readonly string[]).includes(code)) {
    throw new FeedError(
      'BANK_FEED_UNSUPPORTED_PROVIDER',
      `Bank feed transport for "${code}" is not implemented yet.`,
    );
  }

  throw new FeedError(
    'BANK_FEED_UNSUPPORTED_PROVIDER',
    `Unknown bank feed provider "${code}".`,
  );
}

/** Codes the registry knows about — used by the architecture ratchet. */
export const KNOWN_PROVIDER_CODES: readonly string[] = [
  ...Object.keys(ADAPTERS),
  ...UNIMPLEMENTED,
  ...NOT_A_FEED,
];
