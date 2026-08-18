/**
 * The ONE server-side seam that answers "what currency does this workspace
 * speak?".
 *
 * History: the AI assistant used to read `organizations.base_currency` — a
 * column that does not exist — so the select failed, the row came back null,
 * and a `|| 'USD'` fallback told every model that every workspace was a USD
 * workspace. The canonical source is `businesses.base_currency`, exactly as
 * the frontend (`useViewCurrencyPreference`, `useTenantFx`) and the document
 * pipeline already read it.
 *
 * There is deliberately NO literal currency fallback in this file. When the
 * workspace currency cannot be resolved we say so; we never invent one.
 */

export interface WorkspaceCurrencyContext {
  /** ISO code of the base currency, or null when it cannot be resolved. */
  baseCurrency: string | null;
  /** True when businesses in scope disagree — report per document instead. */
  mixed: boolean;
  /** Distinct base currencies seen across the businesses in scope. */
  businessCurrencies: string[];
  /** ISO codes the tenant has switched on for transacting. */
  activeCurrencies: string[];
  /** Country of the scoped business (drives statutory/formatting hints). */
  country: string | null;
  /** Name of the scoped business, when a single business is selected. */
  businessName: string | null;
}

export const UNRESOLVED_CURRENCY_CONTEXT: WorkspaceCurrencyContext = {
  baseCurrency: null,
  mixed: false,
  businessCurrencies: [],
  activeCurrencies: [],
  country: null,
  businessName: null,
};

/**
 * Resolve the workspace currency from the canonical source.
 *
 * Precedence:
 *   1. the selected business's `base_currency`
 *   2. no business selected -> the org's businesses, when they all agree
 *   3. they disagree -> `mixed` (report each document in its own currency)
 *   4. nothing resolvable -> `baseCurrency: null` (never a guessed code)
 */
export async function resolveWorkspaceCurrency(
  supabaseClient: any,
  organizationId: string | undefined,
  businessId?: string | null,
): Promise<WorkspaceCurrencyContext> {
  if (!organizationId) return UNRESOLVED_CURRENCY_CONTEXT;

  const { data: rows, error } = await supabaseClient
    .from("businesses")
    .select("id, name, base_currency, country")
    .eq("organization_id", organizationId);

  if (error) {
    console.error("resolveWorkspaceCurrency: businesses lookup failed", error);
    return UNRESOLVED_CURRENCY_CONTEXT;
  }

  const businesses = (rows ?? []) as Array<{
    id: string;
    name: string | null;
    base_currency: string | null;
    country: string | null;
  }>;

  const scoped = businessId
    ? businesses.filter((b) => b.id === businessId)
    : businesses;

  const businessCurrencies = Array.from(
    new Set(
      scoped
        .map((b) => (b.base_currency || "").trim().toUpperCase())
        .filter((c) => c.length > 0),
    ),
  );

  const mixed = businessCurrencies.length > 1;
  const baseCurrency = businessCurrencies.length === 1 ? businessCurrencies[0] : null;

  const single = businessId ? scoped[0] : (scoped.length === 1 ? scoped[0] : null);

  let activeCurrencies: string[] = [];
  const activeScopeId = businessId ?? single?.id ?? null;
  if (activeScopeId) {
    const { data: activeRows } = await supabaseClient
      .from("business_active_currencies")
      .select("currency_code")
      .eq("business_id", activeScopeId);
    activeCurrencies = Array.from(
      new Set(
        ((activeRows ?? []) as Array<{ currency_code: string | null }>)
          .map((r) => (r.currency_code || "").trim().toUpperCase())
          .filter((c) => c.length > 0),
      ),
    );
  }
  if (baseCurrency && !activeCurrencies.includes(baseCurrency)) {
    activeCurrencies = [baseCurrency, ...activeCurrencies];
  }

  return {
    baseCurrency,
    mixed,
    businessCurrencies,
    activeCurrencies,
    country: single?.country ?? null,
    businessName: businessId ? (single?.name ?? null) : null,
  };
}

/**
 * Format a money value with an EXPLICIT ISO code. The code is required —
 * there is no default — so no caller can silently emit a guessed currency.
 * Returns an unlabelled number when the currency is genuinely unknown, and
 * the prompt tells the model to say the currency is not configured.
 */
export function formatMoney(amount: number | null | undefined, currency: string | null): string {
  const n = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount || 0);
  const code = (currency || "").trim().toUpperCase();
  return code ? `${code} ${n}` : `${n} (currency not configured)`;
}

/**
 * Format a record that carries its own currency (bank account, invoice,
 * bill, POS transaction...). When it differs from base we say so inline
 * rather than relabelling foreign money with the base code.
 */
export function formatRecordMoney(
  amount: number | null | undefined,
  recordCurrency: string | null | undefined,
  base: string | null,
): string {
  const code = (recordCurrency || "").trim().toUpperCase();
  if (!code) return formatMoney(amount, base);
  const rendered = formatMoney(amount, code);
  if (base && code !== base) return `${rendered} (foreign — workspace base is ${base})`;
  return rendered;
}

/**
 * The currency rule block prepended to EVERY assistant request type, not
 * just chat. Expense categorisation, invoice analysis, email drafting and
 * document text all get the same instruction.
 */
export function buildCurrencyRulePrompt(ctx: WorkspaceCurrencyContext): string {
  if (ctx.mixed) {
    return (
      `**🔒 CURRENCY RULE (STRICT):** This organization's businesses use different base currencies ` +
      `(${ctx.businessCurrencies.join(", ")}). There is NO single workspace currency. ` +
      `Report every amount with the ISO code shown next to it in the data, never convert or ` +
      `re-label, and never fall back to "$" or "USD". If the user asks for a consolidated total, ` +
      `explain that a business must be selected first.\n\n`
    );
  }

  if (!ctx.baseCurrency) {
    return (
      `**🔒 CURRENCY RULE (STRICT):** This workspace has NO base currency configured, so you do ` +
      `NOT know what currency its money is in. Never assume, never write "$" or "USD", and never ` +
      `invent a code. State plainly that the workspace currency is not configured and point the ` +
      `user to Localization Settings (/settings/workspace?tab=localization) to set it. Quote raw ` +
      `numbers without a currency label until it is configured.\n\n`
    );
  }

  const cur = ctx.baseCurrency;
  let block =
    `**🔒 CURRENCY RULE (STRICT):** This workspace's base currency is **${cur}**` +
    (ctx.country ? ` (country: ${ctx.country})` : "") + `. ` +
    `ALL monetary values you write MUST carry an explicit ISO code — "${cur} 1,250.00", ` +
    `"${cur} 0.00" — reproducing exactly the code shown next to each number in the data. ` +
    `NEVER use the "$" sign, and never write "USD" unless "${cur}" is literally USD or a record ` +
    `is explicitly marked as being in USD. This rule overrides any default formatting habit.\n`;

  if (ctx.activeCurrencies.length > 1) {
    block +=
      `Currencies enabled for transacting here: ${ctx.activeCurrencies.join(", ")}. ` +
      `Records marked "(foreign — workspace base is ${cur})" are NOT in ${cur}; keep their own ` +
      `code and do not convert them yourself — say a rate lookup is required instead.\n`;
  }

  return block + "\n";
}
