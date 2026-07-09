# Physical Count → Post to Ledger — Root Cause & Repair

## 1. Business-Event Trace (what actually happens)

```
Approve Count
  └─ UI: PhysicalCountDetail / PhysicalCountWorkspace
       └─ supabase.rpc('physical_count_post', { p_count_id, p_user_id })
            └─ SQL fn public.physical_count_post(uuid, uuid)   [migration 20260709215521]
                 1. Lock physical_counts row, require state='approved'
                 2. governance_assert_not_self(...)             ← SoD gate
                 3. fiscal_periods lookup for CURRENT_DATE, must not be 'closed'
                 4. resolve_default_account(business_id,'inventory')            → v_inv_acct
                 5. resolve_default_account(business_id,'inventory_adjustment') → v_adj_acct
                    IF either NULL → RAISE P0001
                 6. INSERT stock_adjustments (status='draft', …)               ← check constraints
                 7. Loop lines → INSERT stock_adjustment_items + stock_movements (trigger validation)
                 8. UPDATE stock_adjustments status='approved'
                 9. IF net variance value > 0:
                      INSERT journal_entries (journal_book_id = v_c.journal_book_id, status='posted')
                      INSERT journal_entry_lines (debit/credit, account_id FK)
                10. UPDATE physical_counts state='posted'
                11. physical_count_events + business_event_outbox
```

## 2. Real Root Cause

Two independent defects combine into the symptom the user sees.

**Defect A — the frontend hides the real Postgres error.**
Both call sites (`PhysicalCountDetail.tsx:350-362`, `PhysicalCountWorkspace.tsx:128-138`) only treat SQLSTATE codes starting with `P` (`P0001`, `42501`) as "business" errors. Everything else is routed through `ErrorNormalizer.ts`, and SQLSTATE `23514` (check constraint) / `23P01` (exclusion) / HTTP 422 map to the `validation` shape — literally the string *"Some of the information you entered is not valid."* (`ErrorNormalizer.ts:88-93, 197`). NOT-NULL (`23502`) and FK (`23503`) fall into the `unknown` shape. In all four cases the real Postgres `message`, `details`, and `hint` are captured only in `cause` and never rendered. This is why an approved count that fails a downstream constraint looks like a form-validation error.

**Defect B — the RPC only raises P0001 for the *first* prerequisite tier.**
Lines 100-134 raise `P0001` for missing count, wrong state, closed period, missing default accounts (this is the one the user probably actually hits on a fresh org — but with Defect A it never reaches them cleanly). Once the RPC enters the INSERT block (lines 147-333), every remaining failure surfaces as its raw SQLSTATE:
- `physical_counts.journal_book_id` may be NULL for older count rows → `journal_entries.journal_book_id` FK/NOT-NULL error.
- Any `stock_adjustments`/`stock_movements`/`journal_entry_lines` check constraint (allow_negative, non-negative debit/credit, movement_type domain) fires as `23514`.
- Product without `unit_cost_snapshot` where a downstream trigger requires it → NOT-NULL.

That means: **fiscal period missing (not closed, just absent) is silently allowed; a NULL journal book crashes with a raw FK; and a fresh org with unmapped accounts hits P0001 correctly but the user still sees the generic string because Defect A applies.** Wait — P0001 *is* surfaced. So on a fresh Supabase project the very first *unmapped-accounts* raise would give the user the real text. If the user instead sees "Some of the information you entered is not valid.", the failure is *past* the P0001 tier and inside an INSERT — most commonly the NULL `journal_book_id` FK or a `stock_movements`/`journal_entry_lines` check constraint.

## 3. Enterprise Behaviour We Are Aligning To

SAP MI07/MI20, Oracle Fusion Cost Accounting, Odoo `stock.valuation.layer`, D365 F&O counting journal post, and NetSuite Inventory Adjustment all share three properties we currently violate:

1. **Preflight gate before Post.** The Post button is only enabled once posting prerequisites (accounts, period, journal, governance) are green; blockers are enumerated with remediation links. We already have `physical_count_preflight` (referenced in the architecture test) but the UI doesn't gate on it.
2. **Every failure is a named business exception.** Constraint violations are translated into domain messages ("Journal book not configured for warehouse X", "Inventory asset account missing", etc.), never leaked as SQLSTATE.
3. **Post is idempotent and atomic.** A retry after fixing config must not double-post. Our RPC is already atomic; the outbox ON CONFLICT DO NOTHING covers idempotency.

## 4. Repair Plan (three coordinated changes, no duplication)

### 4.1 SQL — harden `physical_count_post` prerequisite tier (new migration)

Extend the P0001 tier *before* any INSERT so every posting blocker is a business exception with a hint:

- Add: **fiscal period must exist** for CURRENT_DATE (currently only "not closed"). Raise P0001 with hint pointing to Fiscal Periods.
- Add: **`journal_book_id` resolution**. If `v_c.journal_book_id IS NULL`, resolve the org's default journal book (e.g. code `GEN`, or first active `journal_books` row for business). If still NULL, raise P0001 with hint "configure a General Journal book".
- Add: **warehouse active** check → P0001.
- Wrap the INSERT block (147-333) in `BEGIN … EXCEPTION WHEN check_violation | not_null_violation | foreign_key_violation THEN RAISE EXCEPTION '<business message>' USING ERRCODE='P0001', HINT=SQLERRM;` so any residual low-level constraint failure is translated into a business error carrying the real Postgres detail as HINT.
- Keep the existing `stock_adjustment` created_by rotation (already correct).

Also extend `physical_count_preflight` (same migration) to return the same expanded blocker set, so UI and RPC agree on the contract.

### 4.2 Frontend — surface Postgres detail, and gate the Post button on preflight

**a. Stop swallowing 23xxx errors.** In `PhysicalCountDetail.tsx:350-362` and `PhysicalCountWorkspace.tsx:128-138`, treat any Postgres error object with a `message` AND a `code` matching `/^(P|23|42)/` as a business error and render `message` (+ `hint` in the toast description, + `details` when present). Fall back to `normalizeError` only when there's no Postgres message at all. This is a display-layer fix only — the normalizer stays intact for non-Postgres errors.

**b. Preflight gating.** On `PhysicalCountDetail` (already calls `physical_count_preflight` per the architecture test), disable the Post button when preflight returns blockers and render a compact "Blocking issues" panel with one remediation link per blocker (Default Accounts, Fiscal Periods, Journal Books, Governance). This is the enterprise pattern and prevents users from ever reaching the raw error path in normal flow.

### 4.3 Verification

- New migration compiles; RPC signature unchanged (still 2-arg) so no frontend contract change is needed.
- Manual: with a fresh org (no default accounts) → Post button is disabled + panel says "Set Inventory & Inventory Adjustment default accounts" with link. Force-clicking Post still returns the same P0001 with the real message rendered.
- Manual: with accounts mapped but no active journal book → new P0001 "General Journal book not configured".
- Manual: with everything mapped → posts, creates `stock_adjustments` + `journal_entries` + outbox row, count moves to `posted`.
- Existing test `src/__tests__/architecture.physical-count-lifecycle.test.ts` continues to pass (no new args, still uses lifecycle RPCs, no client-side JE writes, no `p_allow_self`).

## Technical Details

**Files touched**
- `supabase/migrations/<new>.sql` — CREATE OR REPLACE `physical_count_post(uuid,uuid)` with the expanded prerequisite tier + wrapped INSERT block; CREATE OR REPLACE `physical_count_preflight` returning the expanded blocker list. GRANT EXECUTE to `authenticated` + `service_role`.
- `src/pages/inventory/PhysicalCountDetail.tsx` — error mapping in the post mutation catch; render preflight blockers panel; disable Post button when blockers present.
- `src/pages/inventory/PhysicalCountWorkspace.tsx` — same error-mapping fix on the workspace-level Post action.
- No changes to `ErrorNormalizer.ts` (still correct for non-Postgres errors), no changes to `useGLPosting` (not on this path), no changes to governance (`governance_assert_not_self` already raises P0001 correctly).

**Governance / SoD**
Reuses existing `governance_assert_not_self` unchanged. No duplicated governance logic.

**Idempotency**
`business_event_outbox` ON CONFLICT DO NOTHING already in place; retries after fixing config are safe.

**Out of scope**
Chart-of-accounts seeding, journal book seeding, and default-account UI already exist elsewhere in the app; this plan links to them from the blockers panel rather than reimplementing.
