# Consolidation — simulate a real elimination run, then fix what the refusal exposed

Scope: reproduce the failed "Generate eliminations" event on the live
`AccrualFlowCorporation` tenant, establish the real cause, and fix it properly.
Brick 8 (persisted consolidation runs) stays out of scope.

## Verified current state (checked this session against the live database and repo)

Confirmed by direct queries and file reads, not from the previous log:

- **Group and scope are real.** `Joshua Holdings Group` (JHG), presentation
  currency KES, parent `Joshua Holdings` (KES). Two full-method members at 100%:
  Joshua Holdings (KES, from 2020-01-01) and Mombasa Port Services (USD, from
  2026-01-01). 7 group accounts, 147 account mappings, a CTA group account is
  set on the group, 2 intercompany partner declarations (both directions).
- **The intercompany fixture is a single reciprocal pair, dated 2026-06-30:**
  - Joshua Holdings, KES: Dr 1180 Intercompany receivable 2,630,000 /
    Cr 4180 Intercompany management fees 2,630,000.
  - Mombasa Port Services, USD: Dr 5180 Intercompany management fees 20,000 /
    Cr 2180 Intercompany payable 20,000.
  - Both entries are posted, tagged to the declared partner contacts, and every
    one of the four accounts is mapped to a group account.
- **FX history:** monthly USD→KES manual rates 126.00 (Jan) rising to 131.50 at
  2026-06-30, then 132/133, then a provider series at 129.50 from mid-August.
  20,000 × 131.50 = 2,630,000 exactly.
- **No elimination rule rows exist for this group** —
  `consolidation_elimination_rules` is empty, so the engine falls back to
  `tolerance 0` and `difference_policy = refuse`.
- **Zero rows in `consolidation_eliminations`** — no run has ever succeeded.

### Diagnosis of the 400

The engine settles each company pair per elimination class and refuses when the
two sides disagree beyond tolerance without a named difference account
(`ERRCODE 22023` → PostgREST 400). Two disagreements are structurally
guaranteed with this fixture:

- **`intercompany_trading`**: IAS 21 translates income/expense at the *period
  average* rate. The subsidiary's USD 20,000 expense becomes ~2,56x,xxx KES at
  a Jan–Jun average, against the parent's 2,630,000 KES income booked at spot.
  The residual is a genuine translation difference, not a data error.
- **`intercompany_balance`**: ties to zero only when the period's *closing* rate
  is 131.50, i.e. a period ending 2026-06-30. For any later period end
  (e.g. year-to-date, closing 129.50) the pair disagrees by ~40,000 KES.

So the refusal is the engine behaving as designed on data that no policy has
been configured for. Two real defects sit behind it:

1. **The refusal reason never reaches the user.** The hook does
   `if (error) throw error`, throwing a PostgrestError *plain object*. The page
   then does `e instanceof Error ? e.message : "The elimination run was refused"`
   — false for a PostgrestError — so the specific, carefully worded server
   message ("the two sides of the ... position between A and B differ by X KES")
   is discarded and the user gets a bare "refused" with no reason. This is the
   direct cause of the unactionable screen.
2. **A cross-currency group has no honest default for the average-vs-closing
   residual.** Mature systems (Oracle FCCS, NetSuite, D365 F&O) never refuse
   this class of run: the residual on intercompany translation is routed to CTA
   / a designated translation-difference account under IAS 21 / ASC 830.
   Refusing forever means a multi-currency group can never eliminate at all.

## What this brick does

### 1. Surface the server's refusal verbatim
Normalise Supabase errors into real `Error` objects at the hook boundary
(message + `details`/`hint` preserved, code retained) for every consolidation
call site, so refusals print the exact pair, amount, rate class or mapping at
fault. Cover it with a test asserting a PostgrestError-shaped rejection still
produces its message on screen.

### 2. Make the difference treatment configurable and honest
- Add a `post_to_cta` difference policy handling: the residual on a
  cross-currency intercompany pair posts to the group's CTA account, labelled
  as a translation difference, instead of requiring a hand-picked account.
- Keep `refuse` as the default for **same-currency** pairs, where a
  disagreement really is a data error and must not be papered over.
- The engine records which policy was applied, the rate classes on both sides
  and both untranslated amounts in `source_evidence`, so the number stays
  explainable.
- The rules editor in the consolidation group settings exposes the new policy
  with copy explaining when each is correct.

### 3. Simulate the real event end to end
Drive the actual UI in a browser against the live tenant, signed in as a real
user, and run **Generate** for:
- 2026-01-01 → 2026-06-30 (closing rate ties the balance leg; trading leg leaves
  a translation residual → routed to CTA, balance leg eliminates to zero),
- 2026-01-01 → 2026-12-31 (closing rate 129.50; balance leg also leaves a
  residual → routed to CTA),
- a same-currency disagreement (seeded intra-KES pair with a deliberate 500 KES
  mismatch) → run refused with the reason legible on screen,
- a second run over the same period → identical set, no duplicates.

Where the tenant lacks a scenario, test data is seeded through the normal
posting path (a KES↔KES intercompany pair between two KES members, or an extra
period's entries), never by writing engine-output tables.

### 4. Prove the arithmetic
Extend `supabase/tests/consolidation_eliminations_test.sql` with the
cross-currency residual case (asserting the residual equals
`closing/average rate delta × the foreign amount`, and that the eliminated
consolidated balance sheet still reports `is_balanced`), and re-run the whole
behaviour suite plus the consolidation architecture tests.

### 5. Checkpoint
Append to `.lovable/consolidation-brick-log.md`: the reproduced failure, the
verified cause, the policy semantics now enforced, the executed evidence, and
the confirmation that Brick 7 is genuinely usable before Brick 8 begins.

## Explicitly not in this brick

Persisted/versioned consolidation runs (Brick 8), non-controlling interest,
unrealised profit in inventory, intercompany fixed-asset transfers, investment
vs equity elimination, consolidated cash flow. No placeholders for them.

## Technical notes

- Engine changes go through a migration; the difference-routing logic stays in
  `consolidation_generate_eliminations`, not in TypeScript.
- No second FX resolver: rates keep coming from
  `consolidation_member_translation_rates` → `fx_rate_on` /
  `fx_period_average_rate`.
- No second accounting engine: eliminations keep consuming
  `consolidation_intercompany_flows` →
  `get_consolidated_trial_balance_translated` → the finance primitives.
- Authorisation is unchanged: SECURITY INVOKER engine functions plus the
  org-role check on generation.
