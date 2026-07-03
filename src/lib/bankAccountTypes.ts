/**
 * Unified bank account type definitions with GL account mapping.
 * Single source of truth for BankAccountSheet and BankAccountCard.
 *
 * Bank `account_type` values map to COA `detail_type` — NOT to COA `account_type`.
 * This mapping drives dynamic GL account filtering so users can't accidentally
 * link a credit-card bank account to an asset GL account.
 */

export interface BankAccountTypeConfig {
  /** Value stored in bank_accounts.account_type */
  value: string;
  /** Human-readable label */
  label: string;
  /** The COA account_type that this bank type maps to */
  glAccountType: "asset" | "liability";
  /** Preferred COA detail_types to show in the GL dropdown */
  glDetailTypes: string[];
  /**
   * @deprecated Name-based fallback was locale-fragile and produced empty
   * dropdowns for tenants with non-English COAs. We now rely solely on
   * structured `detail_type` (backfilled by `backfill_account_detail_types`)
   * + `account_type`. Field kept on the type for backwards compatibility
   * with any external consumers; do not add new patterns here.
   */
  glNameFallbacks?: string[];
}

export const BANK_ACCOUNT_TYPES: BankAccountTypeConfig[] = [
  {
    value: "checking",
    label: "Checking / Current",
    glAccountType: "asset",
    glDetailTypes: ["checking", "cash_and_cash_equivalents", "other_current_assets"],
    glNameFallbacks: ["bank", "current", "checking"],
  },
  {
    value: "savings",
    label: "Savings",
    glAccountType: "asset",
    glDetailTypes: ["savings", "cash_and_cash_equivalents"],
    glNameFallbacks: ["saving"],
  },
  {
    value: "money_market",
    label: "Money Market",
    glAccountType: "asset",
    glDetailTypes: ["money_market", "cash_and_cash_equivalents"],
    glNameFallbacks: ["money market"],
  },
  {
    value: "mobile_wallet",
    label: "Mobile Money (M-Pesa, etc.)",
    glAccountType: "asset",
    glDetailTypes: ["mobile_money", "cash_and_cash_equivalents", "cash_on_hand", "other_current_assets"],
    glNameFallbacks: ["mobile", "mpesa", "m-pesa"],
  },
  {
    value: "cash",
    label: "Cash / Petty Cash",
    glAccountType: "asset",
    glDetailTypes: ["cash_on_hand", "cash_and_cash_equivalents"],
    glNameFallbacks: ["cash", "petty"],
  },
  {
    value: "credit_card",
    label: "Credit Card",
    glAccountType: "liability",
    glDetailTypes: ["credit_card", "other_current_liabilities"],
    glNameFallbacks: ["credit card"],
  },
  {
    value: "loan",
    label: "Loan",
    glAccountType: "liability",
    glDetailTypes: ["notes_payable", "other_current_liabilities", "long_term_debt"],
    glNameFallbacks: ["loan"],
  },
];

/** Look up a bank account type config by its value */
export function getBankAccountType(value: string | null | undefined): BankAccountTypeConfig | undefined {
  return BANK_ACCOUNT_TYPES.find((t) => t.value === value);
}

/** Get the display label for a bank account type value */
export function getBankAccountTypeLabel(value: string | null | undefined): string {
  return getBankAccountType(value)?.label ?? value ?? "Unknown";
}

/**
 * Filter GL accounts suitable for linking to a given bank account type.
 * Uses the type's glAccountType + glDetailTypes for precise filtering,
 * with a name-based fallback for accounts without detail_type set.
 */
export function filterGLAccountsForBankType(
  glAccounts: Array<{
    id: string;
    account_type: string;
    detail_type: string | null;
    is_active: boolean | null;
    name: string;
    code: string;
  }>,
  bankAccountType: string,
): typeof glAccounts {
  const config = getBankAccountType(bankAccountType);
  if (!config) return [];

  return glAccounts.filter((a) => {
    if (!a.is_active) return false;
    if (a.account_type !== config.glAccountType) return false;

    // Structured match on detail_type (the canonical Odoo/QBO approach).
    // Accounts without detail_type are excluded — they should be backfilled
    // via `backfill_account_detail_types` rather than guessed by name.
    if (a.detail_type && config.glDetailTypes.includes(a.detail_type)) return true;
    return false;
  });
}

/**
 * Lenient fallback used ONLY when the strict filter returns nothing AND
 * the user has no current GL link to preserve. Returns every active GL
 * account of the right `account_type` (asset or liability) so the user can
 * still pick something, with a UI warning that the type was not
 * automatically detected. This is preferable to an empty dropdown, which
 * looks broken.
 */
export function fallbackGLAccountsForBankType(
  glAccounts: Array<{
    id: string;
    account_type: string;
    detail_type: string | null;
    is_active: boolean | null;
    name: string;
    code: string;
  }>,
  bankAccountType: string,
): typeof glAccounts {
  const config = getBankAccountType(bankAccountType);
  if (!config) return [];
  return glAccounts.filter(
    (a) => a.is_active && a.account_type === config.glAccountType,
  );
}
