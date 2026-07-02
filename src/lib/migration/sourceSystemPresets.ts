/**
 * Source system presets for common accounting software exports.
 * Maps each system's typical CSV export columns to our import format.
 */

export type PlatformAccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface ColumnPreset {
  /** Regex patterns to match source column headers */
  patterns: RegExp[];
  /** Our normalized field name */
  targetField: string;
}

export interface SourceSystemPreset {
  name: string;
  description: string;
  /** Patterns that identify this source system by header detection */
  headerFingerprints: RegExp[];
  /** Column mapping presets by import step */
  columnMaps: {
    accounts?: ColumnPreset[];
    contacts?: ColumnPreset[];
    products?: ColumnPreset[];
    trial_balance?: ColumnPreset[];
    open_ar?: ColumnPreset[];
    open_ap?: ColumnPreset[];
    inventory?: ColumnPreset[];
  };
  /** Maps source account type strings to our 5-type model */
  accountTypeMap?: Record<string, PlatformAccountType>;
}

export const SOURCE_SYSTEM_PRESETS: Record<string, SourceSystemPreset> = {
  quickbooks: {
    name: "QuickBooks",
    description: "QuickBooks Online or Desktop export",
    headerFingerprints: [
      /Account\s+Type/i,
      /\bQB\b/i,
      /Detail\s+Type/i,
    ],
    accountTypeMap: {
      "bank": "asset",
      "accounts receivable": "asset",
      "other current asset": "asset",
      "fixed asset": "asset",
      "other asset": "asset",
      "accounts payable": "liability",
      "credit card": "liability",
      "other current liability": "liability",
      "long term liability": "liability",
      "equity": "equity",
      "income": "income",
      "other income": "income",
      "cost of goods sold": "expense",
      "expense": "expense",
      "other expense": "expense",
    },
    columnMaps: {
      accounts: [
        { patterns: [/^Account$/i, /Account\s*Name/i], targetField: "name" },
        { patterns: [/^Number$/i, /Account\s*Number/i, /Acct\.\s*#/i], targetField: "code" },
        { patterns: [/Account\s*Type/i, /^Type$/i], targetField: "account_type" },
        { patterns: [/Detail\s*Type/i, /Sub.?Type/i], targetField: "detail_type" },
        { patterns: [/Description/i], targetField: "description" },
      ],
      contacts: [
        { patterns: [/^Customer$/i, /^Display\s*Name$/i, /^Company$/i, /^Name$/i], targetField: "name" },
        { patterns: [/^Email$/i, /Main\s*Email/i], targetField: "email" },
        { patterns: [/^Phone$/i, /Main\s*Phone/i], targetField: "phone" },
        { patterns: [/Tax\s*Reg/i, /ABN/i, /TIN/i, /Tax\s*ID/i], targetField: "tax_id" },
        { patterns: [/Billing\s*Address/i, /^Address$/i], targetField: "address" },
      ],
      trial_balance: [
        { patterns: [/^Account$/i, /Account\s*Name/i], targetField: "account_name" },
        { patterns: [/^Number$/i, /Account\s*No/i, /Acct\.\s*#/i], targetField: "account_code" },
        { patterns: [/^Debit$/i, /Debit\s*Balance/i], targetField: "debit" },
        { patterns: [/^Credit$/i, /Credit\s*Balance/i], targetField: "credit" },
      ],
      open_ar: [
        { patterns: [/^Customer$/i, /Customer\s*Name/i], targetField: "customer_name" },
        { patterns: [/Invoice\s*#/i, /Num/i, /Ref\s*No/i, /Transaction\s*No/i], targetField: "invoice_number" },
        { patterns: [/^Date$/i, /Invoice\s*Date/i, /Txn\s*Date/i], targetField: "invoice_date" },
        { patterns: [/Due\s*Date/i], targetField: "due_date" },
        { patterns: [/^Amount$/i, /Balance\s*Due/i, /Open\s*Balance/i], targetField: "amount" },
      ],
      open_ap: [
        { patterns: [/^Vendor$/i, /Vendor\s*Name/i, /Supplier/i], targetField: "supplier_name" },
        { patterns: [/Bill\s*#/i, /Ref\s*No/i, /Num/i], targetField: "bill_number" },
        { patterns: [/^Date$/i, /Bill\s*Date/i, /Txn\s*Date/i], targetField: "bill_date" },
        { patterns: [/Due\s*Date/i], targetField: "due_date" },
        { patterns: [/^Amount$/i, /Balance\s*Due/i, /Open\s*Balance/i], targetField: "amount" },
      ],
    },
  },
  odoo: {
    name: "Odoo",
    description: "Odoo ERP export (v14+)",
    headerFingerprints: [
      /External\s+ID/i,
      /Internal\s+Type/i,
      /x_studio/i,
    ],
    accountTypeMap: {
      "receivable": "asset",
      "bank and cash": "asset",
      "current assets": "asset",
      "non-current assets": "asset",
      "fixed assets": "asset",
      "prepayments": "asset",
      "payable": "liability",
      "current liabilities": "liability",
      "non-current liabilities": "liability",
      "equity": "equity",
      "income": "income",
      "other income": "income",
      "cost of revenue": "expense",
      "expenses": "expense",
      "depreciation": "expense",
    },
    columnMaps: {
      accounts: [
        { patterns: [/^Name$/i, /Account\s*Name/i], targetField: "name" },
        { patterns: [/^Code$/i, /Account\s*Code/i], targetField: "code" },
        { patterns: [/Internal\s*Type/i, /^Type$/i, /User\s*Type/i], targetField: "account_type" },
        { patterns: [/^Note$/i, /Description/i], targetField: "description" },
      ],
      contacts: [
        { patterns: [/^Name$/i, /Display\s*Name/i, /Partner\s*Name/i], targetField: "name" },
        { patterns: [/^Email$/i, /E-mail/i], targetField: "email" },
        { patterns: [/^Phone$/i, /Mobile/i], targetField: "phone" },
        { patterns: [/^VAT$/i, /Tax\s*ID/i, /TIN/i], targetField: "tax_id" },
        { patterns: [/^Street$/i, /^Contact\s*Address$/i], targetField: "address" },
        { patterns: [/^Customer\s*Rank$/i, /Is\s*Customer/i], targetField: "is_customer" },
        { patterns: [/^Supplier\s*Rank$/i, /Is\s*Vendor/i], targetField: "is_supplier" },
      ],
      trial_balance: [
        { patterns: [/^Account$/i, /Account\s*Name/i], targetField: "account_name" },
        { patterns: [/^Code$/i, /Account\s*Code/i], targetField: "account_code" },
        { patterns: [/^Debit$/i], targetField: "debit" },
        { patterns: [/^Credit$/i], targetField: "credit" },
        { patterns: [/^Balance$/i, /Initial\s*Balance/i], targetField: "balance" },
      ],
      open_ar: [
        { patterns: [/^Partner$/i, /Customer$/i, /Partner\s*Name/i], targetField: "customer_name" },
        { patterns: [/^Number$/i, /Invoice\s*Number/i, /Reference/i], targetField: "invoice_number" },
        { patterns: [/^Invoice\s*Date$/i, /^Date$/i], targetField: "invoice_date" },
        { patterns: [/^Due\s*Date$/i, /Payment\s*Due/i], targetField: "due_date" },
        { patterns: [/^Amount\s*Due$/i, /Residual/i, /Amount\s*Total/i], targetField: "amount" },
      ],
      open_ap: [
        { patterns: [/^Partner$/i, /Vendor$/i, /Partner\s*Name/i], targetField: "supplier_name" },
        { patterns: [/^Number$/i, /Bill\s*Reference/i, /Reference/i], targetField: "bill_number" },
        { patterns: [/^Bill\s*Date$/i, /^Date$/i], targetField: "bill_date" },
        { patterns: [/^Due\s*Date$/i, /Payment\s*Due/i], targetField: "due_date" },
        { patterns: [/^Amount\s*Due$/i, /Residual/i, /Amount\s*Total/i], targetField: "amount" },
      ],
    },
  },
  tally: {
    name: "Tally",
    description: "Tally ERP / Tally Prime export",
    headerFingerprints: [
      /Particulars/i,
      /Closing\s+Balance/i,
      /Ledger\s+Name/i,
    ],
    accountTypeMap: {
      "sundry debtors": "asset",
      "bank accounts": "asset",
      "bank occ a/c": "asset",
      "cash-in-hand": "asset",
      "current assets": "asset",
      "fixed assets": "asset",
      "investments": "asset",
      "loans & advances (asset)": "asset",
      "stock-in-hand": "asset",
      "deposits (asset)": "asset",
      "sundry creditors": "liability",
      "current liabilities": "liability",
      "duties & taxes": "liability",
      "provisions": "liability",
      "secured loans": "liability",
      "unsecured loans": "liability",
      "loans (liability)": "liability",
      "capital account": "equity",
      "reserves & surplus": "equity",
      "retained earnings": "equity",
      "sales accounts": "income",
      "direct incomes": "income",
      "indirect incomes": "income",
      "income (direct)": "income",
      "income (indirect)": "income",
      "purchase accounts": "expense",
      "direct expenses": "expense",
      "indirect expenses": "expense",
      "manufacturing expenses": "expense",
    },
    columnMaps: {
      accounts: [
        { patterns: [/^Particulars$/i, /Ledger\s*Name/i, /^Name$/i], targetField: "name" },
        { patterns: [/^Alias$/i, /^Code$/i], targetField: "code" },
        { patterns: [/^Group$/i, /Under\s*Group/i, /Parent/i], targetField: "account_type" },
      ],
      trial_balance: [
        { patterns: [/^Particulars$/i, /Ledger\s*Name/i], targetField: "account_name" },
        { patterns: [/^Alias$/i, /^Code$/i], targetField: "account_code" },
        { patterns: [/^Debit$/i, /Closing.*Dr/i], targetField: "debit" },
        { patterns: [/^Credit$/i, /Closing.*Cr/i], targetField: "credit" },
        { patterns: [/Closing\s*Balance/i], targetField: "balance" },
      ],
    },
  },
  xero: {
    name: "Xero",
    description: "Xero accounting export",
    headerFingerprints: [
      /\*Account\s*Code/i,
      /Tax\s*Code/i,
    ],
    accountTypeMap: {
      "bank": "asset",
      "current": "asset",
      "currliab": "liability",
      "current liability": "liability",
      "termliab": "liability",
      "non-current liability": "liability",
      "equity": "equity",
      "revenue": "income",
      "sales": "income",
      "other income": "income",
      "directcosts": "expense",
      "overheads": "expense",
      "expense": "expense",
      "depreciatn": "expense",
      "fixed": "asset",
      "inventory": "asset",
      "prepayment": "asset",
    },
    columnMaps: {
      accounts: [
        { patterns: [/\*?Account\s*Name/i, /^Name$/i], targetField: "name" },
        { patterns: [/\*?Account\s*Code/i, /^Code$/i], targetField: "code" },
        { patterns: [/\*?Account\s*Type/i, /^Type$/i], targetField: "account_type" },
        { patterns: [/Description/i], targetField: "description" },
        { patterns: [/Tax\s*Code/i], targetField: "tax_code" },
      ],
      contacts: [
        { patterns: [/\*?Contact\s*Name/i, /^Name$/i], targetField: "name" },
        { patterns: [/Email/i], targetField: "email" },
        { patterns: [/Phone/i], targetField: "phone" },
        { patterns: [/Tax\s*Number/i, /ABN/i], targetField: "tax_id" },
        { patterns: [/Address/i, /Street/i], targetField: "address" },
      ],
      trial_balance: [
        { patterns: [/^Account$/i, /Account\s*Name/i], targetField: "account_name" },
        { patterns: [/Account\s*Code/i, /^Code$/i], targetField: "account_code" },
        { patterns: [/^Debit$/i, /YTD\s*Debit/i], targetField: "debit" },
        { patterns: [/^Credit$/i, /YTD\s*Credit/i], targetField: "credit" },
      ],
    },
  },
};

/**
 * Detect which source system a CSV header row likely came from.
 * Returns the preset key or null if no match.
 */
export function detectSourceSystem(headers: string[]): string | null {
  const headerStr = headers.join(" ");
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const [key, preset] of Object.entries(SOURCE_SYSTEM_PRESETS)) {
    const matchCount = preset.headerFingerprints.filter(fp => fp.test(headerStr)).length;
    if (matchCount > bestScore) {
      bestScore = matchCount;
      bestMatch = key;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

/**
 * Given a source system and step, map source headers to normalized field names.
 */
export function mapColumnsForSystem(
  systemKey: string,
  step: string,
  headers: string[]
): Record<string, string> {
  const preset = SOURCE_SYSTEM_PRESETS[systemKey];
  if (!preset) return {};

  const columnMaps = (preset.columnMaps as any)[step] as ColumnPreset[] | undefined;
  if (!columnMaps) return {};

  const mapping: Record<string, string> = {};

  for (const colMap of columnMaps) {
    for (const header of headers) {
      if (colMap.patterns.some(p => p.test(header))) {
        mapping[header] = colMap.targetField;
        break;
      }
    }
  }

  return mapping;
}

/**
 * Generic fallback map for account types not covered by source-system presets.
 * Covers common patterns across many accounting systems.
 */
const GENERIC_ACCOUNT_TYPE_MAP: Record<string, PlatformAccountType> = {
  // Assets
  "asset": "asset", "assets": "asset", "current asset": "asset", "current assets": "asset",
  "other current asset": "asset", "fixed asset": "asset", "fixed assets": "asset",
  "other asset": "asset", "other assets": "asset", "bank": "asset", "cash": "asset",
  "accounts receivable": "asset", "receivable": "asset", "inventory": "asset",
  "prepaid": "asset", "prepayment": "asset", "prepayments": "asset",
  // Liabilities
  "liability": "liability", "liabilities": "liability", "current liability": "liability",
  "current liabilities": "liability", "other current liability": "liability",
  "long term liability": "liability", "non-current liability": "liability",
  "accounts payable": "liability", "payable": "liability", "credit card": "liability",
  // Equity
  "equity": "equity", "owner's equity": "equity", "shareholders equity": "equity",
  "retained earnings": "equity", "capital": "equity",
  // Income (maps to DB enum "income")
  "revenue": "income", "income": "income", "sales": "income",
  "other income": "income", "service revenue": "income",
  // Expense
  "expense": "expense", "expenses": "expense", "cost of goods sold": "expense",
  "cogs": "expense", "other expense": "expense", "operating expense": "expense",
  "depreciation": "expense",
};

/**
 * Normalize an account type string from any source system to our 5-type model.
 * Priority: source-system-specific map > generic map > exact match > null.
 */
export function normalizeAccountType(
  sourceType: string,
  systemKey?: string | null
): PlatformAccountType | null {
  const normalized = sourceType.trim().toLowerCase();

  // Already a valid platform type
  const validTypes: PlatformAccountType[] = ["asset", "liability", "equity", "income", "expense"];
  if (validTypes.includes(normalized as PlatformAccountType)) {
    return normalized as PlatformAccountType;
  }

  // Check source-system-specific map first
  if (systemKey && SOURCE_SYSTEM_PRESETS[systemKey]?.accountTypeMap) {
    const mapped = SOURCE_SYSTEM_PRESETS[systemKey].accountTypeMap![normalized];
    if (mapped) return mapped;
  }

  // Fall back to generic map
  const genericMapped = GENERIC_ACCOUNT_TYPE_MAP[normalized];
  if (genericMapped) return genericMapped;

  return null;
}
