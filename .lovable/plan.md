# Inventory ⇄ GL Reconciliation — audit verdict and remediation plan

## What this report is supposed to be

It is a **control-account reconciliation**: the classic "subledger ties to the
control account" proof that every audited ERP must produce. Inventory is a
subledger (quantities × cost, per product per warehouse). The GL holds one
Inventory control account. The report must prove, **as at a stated date**:

```text
Σ (stock on hand × valuation cost)   ==   Inventory control account balance
        subledger side                          ledger side
             │                                      │
             └──────────── difference ──────────────┘
                     must be zero, and if not,
                     must be explainable line by line
```

A professional version of this document has four parts: (1) the tie-out
summary per inventory control account, (2) the composition of the subledger
side so a number can be defended, (3) an explanation of the difference
(unposted / missing journals, zero-cost stock, negative stock, non-inventory
postings into the control account), and (4) an audit trail of every
remediation posted from this screen. Today the page shows part (1) only.

## Verdict on the current page

The tie-out row is real (RPC-computed, not decoration) and it currently
agrees at 49,350.00. Everything around it is weaker than it looks.

### 1. "Scan negative assets" is broken by construction — confirmed

`detect_negative_asset_findings` does `INSERT INTO
public.accounting_integrity_findings`, but that object is a **view**, not a
table (verified: `relkind = 'v'`). Postgres rejects the insert, PostgREST
returns 500 — exactly the error reported.

Worse, fixing the insert would not help: the integrity panel reads findings
**derived live from views**, and no view emits a `NEGATIVE_ASSET_BALANCE`
code (verified by search). So rows written anywhere would never be displayed.
This control has never worked.

Also, negative *assets* is the wrong check for this report. On an inventory
reconciliation page the meaningful check is **negative stock quantities**,
which is what silently corrupts valuation.

### 2. The subledger is valued on the wrong cost basis

The RPC values stock as `warehouse_stock.quantity × products.cost_price`.
ADR 0016 states `warehouse_stock.average_cost` is the **authoritative
per-warehouse moving-average cost**, and that is what stock movements post to
the GL with. Valuing the tie-out on a different basis than the postings makes
both outcomes untrustworthy: drift can appear where the books are fine, and —
because a later `cost_price` edit moves both nothing in GL and everything
here — a zero drift can be coincidence.

### 3. The GL side reads a denormalised column

It uses `accounts.current_balance` rather than summing posted
`journal_entry_lines`. Every other statement in the app (Trial Balance,
General Ledger, the integrity views) derives balances from posted lines. A
reconciliation that trusts a cached column cannot detect the one failure mode
it exists to detect: GL rows that moved without the cache following.

### 4. No date, no scope

- No **as-at date**. The report is implicitly "now", so it can never be run
  for a closed period or attached to a month-end file.
- The branch filter is rendered and ignored (documented, acceptable), but
  `business_id` is ignored too: the subledger sums **all stock in the
  organisation** while the GL side is one company's account. In a
  multi-company org the tie-out is arithmetically wrong.
- Only the single `inventory` default account is considered; orgs with more
  than one inventory control account get a silently partial report.

### 5. "Post opening inventory" is riskier than the label implies

`backfill_opening_inventory_gl`:
- picks the company with `SELECT id FROM businesses ... LIMIT 1` — arbitrary
  in a multi-company org;
- posts an amount derived from zero-cost stock movements, **not** from the
  measured drift, so pressing it may leave the drift unchanged;
- rewrites historical `stock_movements.unit_cost` in place, mutating history
  the audit trail is supposed to preserve;
- guards idempotency with one opening entry **per organisation**, which
  blocks a legitimate second company;
- offers no preview of what will be posted before it posts.

### 6. Two `get_accounting_integrity_findings` overloads exist

One takes `(boolean)`, one takes `(_org_id, ...)`. Overloaded RPCs on
PostgREST are a live ambiguity risk; only one should survive.

## Remediation plan

### A. Fix the failing control (immediate)

- Replace "Scan negative assets" with **"Scan negative stock"**, backed by a
  new read-only RPC `list_negative_stock_positions(p_org, p_business)`
  returning product, warehouse, quantity, and valuation impact. Read-only —
  it reports, it does not write findings.
- Add a `stock_negative_quantity` finding to the integrity views (severity
  `critical`) so the same condition also surfaces in the Accounting Integrity
  panel, consistent with how every other finding is produced.
- Drop `detect_negative_asset_findings` and its client hook.

### B. Make the tie-out defensible

New `reconcile_inventory_subledger_to_gl(p_org, p_business, p_as_of)`:
- valuation basis `COALESCE(warehouse_stock.average_cost, products.cost_price)`
  with a per-row `basis` flag so fallbacks are visible, not hidden;
- GL side = `SUM(debit − credit)` over **posted** journal entry lines with
  `entry_date <= p_as_of`, company-scoped;
- subledger scoped to the same company;
- returns one row per configured inventory control account.
- Keep the old signature as a thin wrapper so nothing breaks mid-deploy.

### C. Make it an actual report

On `InventoryGLReconciliation`:
- as-at date control (defaults to today), included in the export header;
- **Subledger composition** table: warehouse → product → qty → unit cost →
  value, with a total that must equal the subledger column, plus rows flagged
  for zero cost or negative quantity;
- **Difference explained** section listing: approved adjustments with no
  journal (already available via `list_adjustments_missing_journals`),
  zero-cost stock value, negative stock value, and non-inventory-source
  postings into the control account, with the residual unexplained amount
  stated plainly;
- **Remediation log**: every backfill posted from this screen, from the
  existing `stock_adjustment_backfill_log`;
- export covers all sections, not just the one-row grid.

### D. Make remediation safe

- `backfill_opening_inventory_gl(p_org, p_business, p_as_of, p_dry_run)`:
  explicit company, dry-run preview returned to a confirmation dialog,
  idempotency keyed per company, no mutation of historical
  `stock_movements.unit_cost`, refuses to post into a locked period.
- Gate the button behind `PermissionGate permission="manageFinancials"` — it
  is currently ungated while the far less dangerous per-row "Post JE now" is
  gated.
- Rename it "Post opening inventory journal…" (ellipsis = opens a dialog).

### E. Housekeeping

- Remove the unused `get_accounting_integrity_findings(boolean)` overload.
- Architecture test: no client code may call a removed/renamed RPC, and the
  reconciliation RPC must derive the GL side from `journal_entry_lines`
  (grep guard against `current_balance` returning).
- pgTAP: zero-drift case, drift case, negative-stock detection, dry-run
  returns without posting, locked-period refusal.
- ADR 0017 recording the valuation basis and the "reconciliation is read-only,
  remediation is explicit and logged" rule.

## Sequencing

1. A + E (broken control, ambiguity) — small, unblocks the page.
2. B (correct tie-out) — migration + wrapper.
3. C (report content) — UI only.
4. D (safe remediation) — migration + dialog.

## Technical notes

- Verified this turn: `accounting_integrity_findings` is a view;
  no `NEGATIVE_ASSET_BALANCE` producer exists anywhere in the codebase;
  the RPC bodies quoted above are the live definitions in the database.
- All new SQL is `SECURITY DEFINER` with `_assert_org_member`, matching the
  existing convention, plus a company-membership assertion where a
  `business_id` argument is introduced.
