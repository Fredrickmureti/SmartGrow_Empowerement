/**
 * Deterministic Default Account Mapping Engine
 * =============================================
 *
 * Pure, side-effect-free scoring engine that proposes a Chart-of-Accounts
 * candidate for each canonical accounting role declared in
 * `system_account_roles`.
 *
 * Design principles (matches the migration-2 contract):
 *   1. account_type MUST equal `role.required_account_type`. Otherwise the
 *      candidate is hard-rejected (score = -Infinity, eligible = false).
 *   2. detail_type MUST appear in `account_role_eligibility` for that role.
 *      Otherwise the candidate is hard-rejected. The `priority` of that
 *      eligibility row is the PRIMARY signal (lower = better).
 *   3. Code prefix conventions and name keywords are TIE-BREAKERS only.
 *      They never promote an ineligible account to eligible.
 *   4. `is_active = false` accounts are excluded.
 *   5. Confidence buckets are derived deterministically from the score and
 *      the candidate gap, NEVER from heuristics about the account name.
 *
 * The same logic is consumed by:
 *   - the `preview-default-mappings` edge function (proposal phase),
 *   - the `apply-default-mappings` edge function (commit phase),
 *   - the unit tests under `__tests__/mappingEngine.test.ts`.
 */

export type AccountTypeKey = "asset" | "liability" | "equity" | "income" | "expense";

export interface CandidateAccount {
  id: string;
  code: string;
  name: string;
  account_type: AccountTypeKey;
  detail_type: string | null;
  is_active: boolean;
  business_id: string | null;
}

export interface RoleDefinition {
  role_key: string;
  label: string;
  description: string;
  required_account_type: AccountTypeKey;
  is_mandatory: boolean;
  category: string;
  sort_order: number;
}

export interface EligibilityRow {
  role_key: string;
  account_type: AccountTypeKey;
  detail_type: string;
  priority: number;
}

export type Confidence = "exact" | "strong" | "weak" | "none";

export interface ScoredCandidate {
  account: CandidateAccount;
  score: number;
  confidence: Confidence;
  eligible: boolean;
  reasons: string[];
}

export type ProposalStatus =
  | "auto_mapped"   // single eligible candidate OR clear winner
  | "ambiguous"     // multiple eligible candidates with similar scores
  | "missing"       // no eligible candidate
  | "preserved";    // existing mapping is already valid; engine left it alone

export interface RoleProposal {
  role: RoleDefinition;
  status: ProposalStatus;
  selected: ScoredCandidate | null;
  alternatives: ScoredCandidate[]; // ranked, includes selected
  current_account_id: string | null;
  message: string;
}

/* ───────────────────────── Tunable scoring constants ───────────────────────── */

// Eligibility-priority is the primary signal. We invert it so lower priority
// becomes a higher base score: BASE - priority. With BASE=1000 and typical
// priorities 10..60, eligible accounts land in the 940..990 band.
const ELIGIBILITY_BASE = 1000;

// Tie-breaker bonuses — small enough to never override the eligibility band
// (one priority step = 1 point), but large enough that an UNAMBIGUOUS
// name-match can lift a candidate clear of the STRONG_GAP threshold.
const CODE_PREFIX_BONUS = 5;
const NAME_KEYWORD_BONUS = 8;
const BUSINESS_SCOPED_BONUS = 2; // prefer accounts scoped to current business
const SHORTER_CODE_BONUS = 1;    // prefer "1000" over "1000-001"

// Decision thresholds for confidence buckets (relative to the winner).
const STRONG_GAP = 8;  // winner beats #2 by at least this → strong
const EXACT_PRIORITY_THRESHOLD = 15; // eligibility priority <= this → exact

/* ───────────────────────── Code-prefix hints per role ────────────────────────
   These only act as TIE-BREAKERS. Missing or extra entries can never make an
   ineligible account eligible. They mirror common ERP CoA conventions but are
   intentionally permissive. */
const CODE_PREFIX_HINTS: Record<string, readonly string[]> = {
  cash: ["1000", "1001", "100"],
  bank: ["1010", "1020", "101", "102"],
  accounts_receivable: ["1100", "1110", "110"],
  inventory: ["1200", "120"],
  input_tax: ["1300", "130"],
  fixed_asset: ["1500", "150", "1510", "1520", "1530", "1540"],
  accumulated_depreciation: ["1590", "159"],
  suspense: ["1900", "190"],
  credit_card_clearing: ["1050", "105"],
  mobile_money: ["1060", "106"],
  mpesa: ["1061", "1062"],

  accounts_payable: ["2000", "200"],
  output_tax: ["2100", "210"],
  customer_deposits: ["2200", "220"],

  opening_balance_equity: ["3100", "310"],
  retained_earnings: ["3200", "320"],

  sales_revenue: ["4000", "400"],
  other_income: ["4500", "450"],

  cogs: ["5000", "500"],
  inventory_adjustment: ["5100", "510"],
  operating_expenses: ["6000", "600"],
  depreciation_expense: ["6100", "610"],
};

/* ───────────────────────── Name-keyword hints per role ─────────────────────── */
const NAME_KEYWORD_HINTS: Record<string, readonly string[]> = {
  cash: ["cash", "petty"],
  bank: ["bank", "checking", "savings", "current account"],
  accounts_receivable: ["receivable", "debtors", "a/r", "ar control"],
  accounts_payable: ["payable", "creditors", "a/p", "ap control"],
  inventory: ["inventory", "stock"],
  input_tax: ["input tax", "vat receivable", "gst receivable", "sales tax receivable"],
  output_tax: ["output tax", "vat payable", "gst payable", "sales tax payable"],
  sales_revenue: ["sales", "product sales", "merchandise", "turnover", "goods sold"],
  service_revenue: ["service", "service revenue", "service income", "consulting", "professional fees"],
  other_income: ["other income", "miscellaneous income", "interest income"],
  fx_realized_gain: ["foreign exchange", "fx gain", "exchange gain", "currency gain"],
  fx_realized_loss: ["foreign exchange", "fx loss", "exchange loss", "currency loss"],
  rounding_gain: ["rounding gain", "rounding adjustment"],
  rounding_loss: ["rounding loss", "rounding adjustment"],
  cogs: ["cost of goods", "cogs", "cost of sales"],
  operating_expenses: ["operating", "general expense", "admin"],
  inventory_adjustment: ["inventory adjustment", "stock adjustment", "shrinkage"],
  retained_earnings: ["retained", "earnings"],
  opening_balance_equity: ["opening balance", "obe", "opening equity"],
  suspense: ["suspense", "unmatched", "clearing - suspense"],
  customer_deposits: ["customer deposit", "customer advance", "unearned revenue", "customer credit"],
  fixed_asset: ["fixed asset", "property", "equipment", "furniture", "vehicle", "machinery", "building"],
  accumulated_depreciation: ["accumulated depreciation", "accum. depreciation"],
  depreciation_expense: ["depreciation expense", "depreciation"],
  credit_card_clearing: ["credit card", "card clearing"],
  mobile_money: ["mobile money", "mobile wallet"],
  mpesa: ["m-pesa", "mpesa"],
};

/* ───────────────────────── Anti-keyword penalties ─────────────────────────────
   Names that should DOWNRANK an otherwise-eligible candidate for a role
   (e.g. an account literally named "Foreign Exchange Gains" should not be
   the top pick for "Sales Revenue", even though both have detail_type
   `sales_income`). The penalty is large enough to drop the candidate below
   another eligible peer with no anti-keyword hit. */
const NAME_ANTIKEYWORD_HINTS: Record<string, readonly string[]> = {
  sales_revenue: ["foreign exchange", "fx", "rounding", "interest", "rental", "dividend", "gain on", "discount"],
  service_revenue: ["foreign exchange", "fx", "rounding", "interest", "rental", "dividend", "gain on", "discount"],
  other_income: ["product sales", "service revenue"],
  accounts_receivable: ["vat", "gst", "input tax", "sales tax"],
  accounts_payable: ["vat", "gst", "output tax"],
};
const NAME_ANTIKEYWORD_PENALTY = 12; // bigger than NAME_KEYWORD_BONUS, smaller than priority steps for adjacent rows

/* ───────────────────────── Public API ───────────────────────── */

/**
 * Classify the confidence of the candidate at index `i` within a ranked list,
 * relative to its neighbours. Pure: depends only on the ranked scores.
 *
 *  • exact  — alone in the list, OR a clear winner with strong eligibility
 *  • strong — beats the next candidate by ≥ STRONG_GAP
 *  • weak   — within STRONG_GAP of an adjacent candidate (ambiguous)
 */
export function classifyConfidenceAt(
  ranked: ScoredCandidate[],
  i: number,
): Confidence {
  if (i < 0 || i >= ranked.length) return "none";
  const me = ranked[i];
  if (!me.eligible) return "none";

  const above = i > 0 ? ranked[i - 1] : null;
  const below = i + 1 < ranked.length ? ranked[i + 1] : null;
  const eligibilityPriority = ELIGIBILITY_BASE - Math.floor(me.score);

  // Solo candidate.
  if (!above && !below) return "exact";

  // For the winner: gap is to runner-up.
  if (!above && below) {
    const gap = me.score - below.score;
    if (gap >= STRONG_GAP * 2) return "exact";
    if (eligibilityPriority <= EXACT_PRIORITY_THRESHOLD && gap >= STRONG_GAP) return "exact";
    if (gap >= STRONG_GAP) return "strong";
    return "weak";
  }

  // For non-winners: confidence is bounded by distance to the candidate ABOVE
  // (you can never be more confident than the one beating you). It also
  // benefits from a clear gap to the candidate BELOW you.
  const gapAbove = above ? above.score - me.score : Number.POSITIVE_INFINITY;
  const gapBelow = below ? me.score - below.score : Number.POSITIVE_INFINITY;

  // If the one above you is very close (gap < STRONG_GAP), you're tied → weak.
  if (gapAbove < STRONG_GAP) return "weak";

  // Otherwise you sit clearly below the winner. Surface "strong" only when
  // your own eligibility is high AND you separate from the one below you.
  if (eligibilityPriority <= EXACT_PRIORITY_THRESHOLD && gapBelow >= STRONG_GAP) {
    return "strong";
  }
  return "weak";
}


export interface ProposeOptions {
  /** Existing setting_key → account_id map. Used to mark proposals "preserved". */
  currentMappings?: Record<string, string | null | undefined>;
  /** Current business id; accounts scoped to it get a small priority bump. */
  currentBusinessId?: string | null;
}

/**
 * Score a single candidate against a single role.
 * Pure: same inputs always produce the same output.
 */
export function scoreCandidate(
  candidate: CandidateAccount,
  role: RoleDefinition,
  eligibilityForRole: EligibilityRow[],
  opts: ProposeOptions = {},
): ScoredCandidate {
  const reasons: string[] = [];

  if (!candidate.is_active) {
    return {
      account: candidate,
      score: Number.NEGATIVE_INFINITY,
      confidence: "none",
      eligible: false,
      reasons: ["Account is inactive."],
    };
  }

  // Hard rule 1: account_type must match the role's required type.
  if (candidate.account_type !== role.required_account_type) {
    return {
      account: candidate,
      score: Number.NEGATIVE_INFINITY,
      confidence: "none",
      eligible: false,
      reasons: [
        `Account type "${candidate.account_type}" does not match required "${role.required_account_type}".`,
      ],
    };
  }

  // Hard rule 2: detail_type must be in the eligibility list.
  const eligibilityRow = candidate.detail_type
    ? eligibilityForRole.find(
        (e) => e.account_type === candidate.account_type && e.detail_type === candidate.detail_type,
      )
    : undefined;

  if (!eligibilityRow) {
    return {
      account: candidate,
      score: Number.NEGATIVE_INFINITY,
      confidence: "none",
      eligible: false,
      reasons: candidate.detail_type
        ? [
            `Detail type "${candidate.detail_type}" is not eligible for role "${role.role_key}".`,
          ]
        : [`Account has no detail_type; cannot be auto-mapped to "${role.role_key}".`],
    };
  }

  // Eligible — start scoring from the inverse of the eligibility priority.
  let score = ELIGIBILITY_BASE - eligibilityRow.priority;
  reasons.push(
    `Detail type "${candidate.detail_type}" is eligible (priority ${eligibilityRow.priority}).`,
  );

  // Tie-breakers — never enough to flip eligibility.
  const codeHints = CODE_PREFIX_HINTS[role.role_key] ?? [];
  const codeLower = (candidate.code || "").toLowerCase();
  const codeMatch = codeHints.find((p) => codeLower.startsWith(p.toLowerCase()));
  if (codeMatch) {
    score += CODE_PREFIX_BONUS;
    reasons.push(`Code "${candidate.code}" matches conventional prefix "${codeMatch}".`);
  }

  const nameHints = NAME_KEYWORD_HINTS[role.role_key] ?? [];
  const nameLower = (candidate.name || "").toLowerCase();
  const nameMatch = nameHints.find((kw) => nameLower.includes(kw));
  if (nameMatch) {
    score += NAME_KEYWORD_BONUS;
    reasons.push(`Name contains keyword "${nameMatch}".`);
  }

  // Anti-keyword penalty — name is semantically wrong for this role.
  // Eligibility is preserved (the user can still pick it), but it should
  // not float to the top.
  const antiHints = NAME_ANTIKEYWORD_HINTS[role.role_key] ?? [];
  const antiMatch = antiHints.find((kw) => nameLower.includes(kw));
  if (antiMatch) {
    score -= NAME_ANTIKEYWORD_PENALTY;
    reasons.push(`Name contains "${antiMatch}" — penalised for role "${role.role_key}".`);
  }

  if (
    opts.currentBusinessId &&
    candidate.business_id &&
    candidate.business_id === opts.currentBusinessId
  ) {
    score += BUSINESS_SCOPED_BONUS;
    reasons.push("Account is scoped to the current business.");
  }

  if (codeLower.length <= 4) {
    score += SHORTER_CODE_BONUS;
  }

  return {
    account: candidate,
    score,
    confidence: "weak", // refined later by proposeMappingForRole based on gap
    eligible: true,
    reasons,
  };
}

/**
 * Produce a single role proposal: ranked candidates + a selection decision.
 */
export function proposeMappingForRole(
  role: RoleDefinition,
  allCandidates: CandidateAccount[],
  eligibilityForRole: EligibilityRow[],
  opts: ProposeOptions = {},
): RoleProposal {
  const currentId = opts.currentMappings?.[role.role_key] || null;

  const scored = allCandidates
    .map((c) => scoreCandidate(c, role, eligibilityForRole, opts))
    .filter((s) => s.eligible)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable tie-break: shorter code, then alphabetical code, then id.
      if (a.account.code.length !== b.account.code.length)
        return a.account.code.length - b.account.code.length;
      if (a.account.code !== b.account.code)
        return a.account.code.localeCompare(b.account.code);
      return a.account.id.localeCompare(b.account.id);
    });

  // Re-classify confidence for EVERY ranked candidate based on its own
  // position vs. the rest of the list. This makes badges meaningful when the
  // user overrides the engine's pick — picking the runner-up should reveal
  // its real confidence, not the default "weak" stub from scoreCandidate().
  for (let i = 0; i < scored.length; i++) {
    scored[i].confidence = classifyConfidenceAt(scored, i);
  }

  // If the user already has a valid mapping for this role, preserve it.
  if (currentId) {
    const currentMatch = scored.find((s) => s.account.id === currentId);
    if (currentMatch) {
      return {
        role,
        status: "preserved",
        selected: currentMatch,
        alternatives: scored,
        current_account_id: currentId,
        message: `Existing mapping preserved (${currentMatch.account.code} ${currentMatch.account.name}).`,
      };
    }
    // Existing mapping points to an account that is no longer eligible.
    // We will propose a replacement but flag it clearly.
    if (scored.length === 0) {
      return {
        role,
        status: "missing",
        selected: null,
        alternatives: [],
        current_account_id: currentId,
        message:
          "Existing mapping is no longer eligible and no replacement candidate exists.",
      };
    }
  }

  if (scored.length === 0) {
    return {
      role,
      status: "missing",
      selected: null,
      alternatives: [],
      current_account_id: currentId,
      message: `No eligible account found for "${role.label}". Create one with a matching detail type.`,
    };
  }

  const top = scored[0];
  if (top.confidence === "weak") {
    return {
      role,
      status: "ambiguous",
      selected: top,
      alternatives: scored,
      current_account_id: currentId,
      message:
        scored.length > 1
          ? `Multiple eligible accounts found; pick one to confirm.`
          : `Single eligible candidate but signal is weak; review before applying.`,
    };
  }

  return {
    role,
    status: "auto_mapped",
    selected: top,
    alternatives: scored,
    current_account_id: currentId,
    message: `Auto-selected ${top.account.code} ${top.account.name} (${top.confidence}).`,
  };
}

/**
 * Build proposals for every role.
 */
export function proposeAllMappings(
  roles: RoleDefinition[],
  eligibility: EligibilityRow[],
  candidates: CandidateAccount[],
  opts: ProposeOptions = {},
): RoleProposal[] {
  const byRole = new Map<string, EligibilityRow[]>();
  for (const e of eligibility) {
    const list = byRole.get(e.role_key) ?? [];
    list.push(e);
    byRole.set(e.role_key, list);
  }

  return roles
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((role) =>
      proposeMappingForRole(role, candidates, byRole.get(role.role_key) ?? [], opts),
    );
}

/**
 * Summarise proposals for UI badges.
 */
export function summariseProposals(proposals: RoleProposal[]) {
  return {
    total: proposals.length,
    auto_mapped: proposals.filter((p) => p.status === "auto_mapped").length,
    preserved: proposals.filter((p) => p.status === "preserved").length,
    ambiguous: proposals.filter((p) => p.status === "ambiguous").length,
    missing: proposals.filter((p) => p.status === "missing").length,
    mandatory_missing: proposals.filter(
      (p) => p.status === "missing" && p.role.is_mandatory,
    ).length,
  };
}