/**
 * Account type synonym resolver.
 * Maps common CSV values to valid account_type enum values.
 */

type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

const TYPE_SYNONYMS: Record<string, AccountType> = {
  asset: "asset",
  assets: "asset",
  "current asset": "asset",
  "fixed asset": "asset",
  "other asset": "asset",
  "bank": "asset",
  "cash": "asset",
  liability: "liability",
  liabilities: "liability",
  "current liability": "liability",
  "long term liability": "liability",
  "other liability": "liability",
  "accounts payable": "liability",
  equity: "equity",
  "owner equity": "equity",
  "owners equity": "equity",
  "shareholders equity": "equity",
  "retained earnings": "equity",
  income: "income",
  revenue: "income",
  sales: "income",
  "other income": "income",
  earnings: "income",
  expense: "expense",
  expenses: "expense",
  cost: "expense",
  "cost of goods sold": "expense",
  cogs: "expense",
  "operating expense": "expense",
  "other expense": "expense",
};

/**
 * Resolve a raw account type string to a valid account_type enum value.
 */
export function resolveAccountType(rawType: string): {
  value: AccountType;
  wasFallback: boolean;
} {
  if (!rawType || !rawType.trim()) {
    return { value: "asset", wasFallback: true };
  }

  const normalized = rawType.toLowerCase().trim();
  const match = TYPE_SYNONYMS[normalized];

  if (match) {
    return { value: match, wasFallback: false };
  }

  // Try partial match
  for (const [key, val] of Object.entries(TYPE_SYNONYMS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return { value: val, wasFallback: false };
    }
  }

  return { value: "asset", wasFallback: true };
}
