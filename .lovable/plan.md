# Loan Product ↔ Loan Application: audit and remediation

## A. Current state (evidence)

Loan product = **identity only** (`mf_loan_products`: code, name, description, status draft/active/retired, `current_version_id`). All commercial terms live on `mf_loan_product_versions`: `currency_code`, `min_amount`/`max_amount`, `min_term_installments`/`max_term_installments`, `repayment_frequency` (daily/weekly/biweekly/monthly), `interest_method`, `interest_rate`, `interest_rate_period`, `grace_period_installments`, `fees` (jsonb), `penalty_rate`, `penalty_basis`, `eligibility` (jsonb), `effective_from`, `is_published`. A published version is frozen by `_mf_lpv_freeze_guard`; repricing publishes a new version.

So the product is **not a fixed package**: it is a versioned rule set with amount and term *bands*. Evidence: the band columns themselves, the constraints `mf_lpv_amount_chk`/`mf_lpv_term_chk`, and both band checks below.

Application (`mf_loan_applications`) stores `requested_amount`, `requested_term_installments`, and separately `approved_amount`, `approved_term_installments`, plus `product_id` and `product_version_id`.

- `mf_apps_requested_chk` only requires requested amount/term > 0. **No band check on requested values anywhere.**
- `_mf_application_guard` on approval requires: authoriser is admin/branch manager, an assessment exists, `product_version_id` is present, approved amount **and** term present, and both inside that version's bands. A decided application's key fields become immutable.
- `sod_mf_loan_applications_guard` blocks self-approval.
- `mf_create_loan_from_application` re-checks the band, then writes the loan from the **version** (currency, frequency, interest method/rate/period, grace, fees, penalty) and from the **application** (amount, term, client, branch, officer, group), generates the schedule, and moves the application to ready_for_disbursement.
- `mf_loans_freeze_terms` forbids changing principal, term, rate, method, frequency or version once the loan leaves pending_disbursement.

Verdict: the intended model is **hybrid** — product version owns the financial rules and the legal envelope; the application owns the customer's requested amount/term; approval decides the contractual amount/term inside the envelope; the loan snapshots everything.

## B. Defects found (each confirmed against code/DB)

1. **The browser pins the pricing version.** `ApplicationFormDialog` sends `product_version_id: currentVersion?.id`. Nothing server-side checks that the version belongs to `product_id`, to the same business, is published, or is in force — only a foreign key exists. A direct API call can pin any version, including another product's or another institution's.
2. **Editing an application silently reprices it.** Every save resends today's in-force version, overwriting the version captured at submission — and writes `null` if versions have not loaded yet. The snapshot intent exists on the loan but is not protected on the application.
3. **A request can become a contract.** `mf_create_loan_from_application` does `COALESCE(a.approved_amount, a.requested_amount)` and the same for term. Any row reaching loan creation without approved values turns an unapproved *request* into contractual principal.
4. **Product eligibility is configured but never enforced.** No `mf_*` function reads `eligibility` (checked across all function bodies) — min/max completed cycles, age, group-membership requirement are dead configuration.
5. **Free-text amount/term with no product context.** Requesting outside the band is legitimate business (it can be declined or approved down), but the inputs are untyped text, accept anything > 0, and the band hint only appears after a product is chosen. No frequency/unit is shown next to "installments".
6. **Client selection is a frontend convenience only.** Branch and officer are defaulted from the client in React; nothing server-side requires the application's branch/officer to match the client's, or that the client and product belong to the same business.

## C. Authoritative rules to enforce

- Product version is the contractual envelope and financial ruleset; it is resolved and validated **server-side** at application creation and never re-pinned after submission.
- Requested amount/term = customer statement of intent. Retained, numeric, may fall outside the band, flagged in the UI, never contractual.
- Approved amount/term = institution's decision, mandatory before approval, band-checked (already true).
- Loan principal/term = approved values only; no fallback to requested.
- Frequency, interest, fees, penalties, grace, currency = product-version-controlled, snapshotted at loan creation, never editable on the application.
- Branch/business/client/officer coherence is a backend invariant.

## D. Field ownership matrix

| Concept | Product | Applicant | Approval | Derived | Validated by | Consumed by |
|---|---|---|---|---|---|---|
| Loan product / version | yes | selects product only | — | version resolved server-side | new guard (Phase 1) | loan, schedule, fees |
| Requested amount / term | band advisory | yes | — | — | `mf_apps_requested_chk` + band warning | reporting, decision context |
| Approved amount / term | band | — | yes | — | `_mf_application_guard` | loan creation |
| Loan principal / term | band | — | source | from approved | `mf_create_loan_from_application` | schedule, accounting |
| Frequency, interest, fees, penalty, grace, currency | yes | — | — | snapshot on loan | version constraints | schedule, penalties, postings |
| Branch / business / client / officer | scope | selects client | — | defaulted from client | new invariant check (Phase 1) | RLS scope, portfolio, reports |

## E. Remediation, phased (one object per migration)

Phase 1 — backend (in order, each verified before the next):
1. Guard function on `mf_loan_applications` insert/update: resolve `product_version_id` server-side from the product's in-force published version when absent; reject a supplied version that is not the product's, not the business's, unpublished, or future-dated; refuse re-pinning once the application leaves draft.
2. Same guard: enforce client/branch/business/product coherence (client belongs to the business; branch matches the client's branch unless an admin overrides; product belongs to the business and is active).
3. Same guard: evaluate the version's `eligibility` (completed cycles, age, group membership) at submission, with clear refusal messages.
4. Replace the `COALESCE(approved…, requested…)` fallback in `mf_create_loan_from_application` with a hard requirement for approved values.

Phase 2 — application workflow: keep requested vs approved separate exactly as today; stop sending `product_version_id` from the browser; surface the pinned version on the application record.

Phase 3 — UI (consequence of the model): numeric inputs for amount and term; show the in-force band with currency and frequency ("12 weekly installments"); non-blocking warning when the request falls outside the band, with the reason it is allowed; block submission only on rules the backend also enforces.

## F. Test matrix

SQL tests under `supabase/tests` plus a signed-in Playwright pass:
A fixed-ish product (min = max) — request/approve at the single value.
B amount range — min, max, below, above, boundaries (request allowed-with-warning, approval rejected outside).
C term range — same set, plus non-numeric input.
D request 15,000/12 → approve 10,000/10 → verify loan principal/term, schedule, disbursement and postings all follow the approved values.
E application against version 1, publish version 2, then approve — must still price on version 1.
F direct API calls with a foreign version, unpublished version, inactive product, out-of-band approval, missing assessment — all rejected.
G product/client from another business or branch — rejected.
H end-to-end consistency: product → application → approval → loan → disbursement → schedule → repayment.

## Notes

Nothing here changes the schedule engine, accounting mappings, RLS scope model, or the loan lifecycle beyond removing the requested-value fallback.


========================================IMPLEMENNTATION STATUS=========================
I verified the earlier claims against the live system before touching anything: the database really does pick the pricing version itself, freezes it once an application is submitted, enforces institution/branch/client coherence and the product's eligibility rules, and a loan can now only be created from an approved amount and term — never from what was merely requested. All the checks passed.

I then finished the remaining items: the approval dialog now explains, when a figure is blocked, that an approval becomes the contract and must sit inside the band of the version the application was priced on (and how to lend outside it); the applications list has a new "Priced on" column showing the product and the exact version each application was priced on; and I added the end-to-end business-rule tests covering scenarios A–H. The app compiles cleanly.

Remaining: a signed-in click-through in the preview (request one amount, approve a lower one, confirm the loan, schedule and postings follow the approved figures), and updating the project status file — I ran out of credits before both.