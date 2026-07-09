## Verdict

No mappings should be seeded. Your observation is correct: **Inventory Adjustment is configured** in the UI registry. The failure is caused by an architectural split and a regression in `physical_count_post`, not by missing user configuration.

The proven disconnect is:

```text
Settings UI / Advanced Accounts
  writes default_account_settings.setting_key = 'inventory'
  writes default_account_settings.setting_key = 'inventory_adjustment'

physical_count_preflight / JE preview
  reads resolve_default_account(..., 'inventory')
  reads resolve_default_account(..., 'inventory_adjustment')

live physical_count_post
  reads resolve_default_account(..., 'inventory_asset')   <-- wrong legacy alias
  reads resolve_default_account(..., 'inventory_adjustment')

resolve_default_account
  reads legacy table default_accounts first
  only has fallback logic for 'inventory', not 'inventory_asset'
```

So the UI can truthfully show `5910 – Inventory Adjustments`, while runtime still throws `Inventory or Inventory Adjustment default accounts are not configured` because the **inventory asset side** is looked up under the obsolete key `inventory_asset`.

## Evidence

### 1. Current physical count being posted

Database evidence for the approved count:

```text
count_id:        4eadc08c-0583-4b2b-aea0-50c2e338ced1
count_number:    PC-000005
state:           approved
organization_id: 8e682296-c634-44c8-ae00-bc48940ec28b
organization:    Joshua Holdings
business_id:     bf392ca6-a743-435c-ae41-5bf25199470d
business:        Joshua Holdings
branch_id:       aeb86a80-af26-437b-a033-e95615fdaa28
warehouse_id:    22782c20-a09b-449d-ad37-89cca25ab988
warehouse:       Headquarters Warehouse
warehouse active:true
product:         Lemonade Soda 300ML
product_category:Beverage
category_id:     26a7e515-c30d-46f7-9b61-e3e854897a00
variance_qty:    60
unit_cost:       30
expected value:  1,800
```

Important: the posting function **does not use product category for account resolution**. The category is `Beverage`, but account lookup is global per business/default role.

### 2. UI configuration is present

The UI component `src/components/finance/DefaultAccountsConfig.tsx` defines Advanced Accounts:

- `inventory` at lines 179–188
- `inventory_adjustment` at lines 241–249
- maps UI config keys to `default_account_settings.setting_key` at lines 305–332
- loads from `default_account_settings` at lines 377–390
- saves to `default_account_settings` at lines 489–517

Database rows prove the mappings exist in the UI/canonical registry:

```text
registry: default_account_settings
setting_key: inventory
account: 1200 – Inventory
account_id: 85db7e0d-a0ec-4d41-8116-b38ef5ab69ac
business_id: bf392ca6-a743-435c-ae41-5bf25199470d
branch_id: null

registry: default_account_settings
setting_key: inventory_adjustment
account: 5910 – Inventory Adjustments
account_id: 2bc9033a-ddb8-4483-8886-050376779ecd
business_id: bf392ca6-a743-435c-ae41-5bf25199470d
branch_id: null
```

The effective-dated binding mirror also exists:

```text
registry: default_account_setting_bindings
setting_key: inventory
account: 1200 – Inventory
source: manual
effective_to: null

registry: default_account_setting_bindings
setting_key: inventory_adjustment
account: 5910 – Inventory Adjustments
source: manual
effective_to: null
```

### 3. Runtime lookup table is different

The live `physical_count_post` function in `supabase/migrations/20260709223205_a0cfa0fc-6e4e-4565-842e-d97321986f7b.sql` does this at lines 57–60:

```sql
v_inv_acct := public.resolve_default_account(v_c.business_id, 'inventory_asset');
v_adj_acct := public.resolve_default_account(v_c.business_id, 'inventory_adjustment');
```

But the live resolver reads `default_accounts`, not `default_account_settings`:

```sql
SELECT account_id
FROM public.default_accounts
WHERE business_id = p_business_id
  AND purpose = p_purpose
  AND branch_id IS NULL;
```

Database evidence:

```text
default_accounts total rows: 0
default_accounts rows for business bf392ca6-a743-435c-ae41-5bf25199470d: 0
```

So the exact failing lookup is effectively:

```sql
SELECT account_id
FROM public.default_accounts
WHERE business_id = 'bf392ca6-a743-435c-ae41-5bf25199470d'
  AND purpose = 'inventory_asset'
  AND branch_id IS NULL;
```

Actual result: **no row**.

The row that should satisfy the business intent exists, but in the canonical UI registry under the canonical key:

```sql
SELECT setting_key, account_id
FROM public.default_account_settings
WHERE organization_id = '8e682296-c634-44c8-ae00-bc48940ec28b'
  AND business_id = 'bf392ca6-a743-435c-ae41-5bf25199470d'
  AND setting_key = 'inventory';
```

Actual row:

```text
setting_key: inventory
account: 1200 – Inventory
```

It does not satisfy the runtime lookup because runtime asks legacy `default_accounts.purpose = 'inventory_asset'` instead of canonical `default_account_settings.setting_key = 'inventory'` / binding resolver.

### 4. Preflight and post disagree

`physical_count_preflight` uses the canonical-ish old key at lines 30–32 of the live function definition:

```sql
v_inv_acct := public.resolve_default_account(v_c.business_id, 'inventory');
v_adj_acct := public.resolve_default_account(v_c.business_id, 'inventory_adjustment');
```

For PC-000005, preflight returns:

```text
inventory_account: true
adjustment_account: true
journal_book: true
period_open: true
warehouse_active: true
```

But `physical_count_post` uses `inventory_asset`, so the Post action can fail even when preflight says the accounts are configured. This is the direct UI-vs-runtime contradiction.

### 5. There are more regressions after the account lookup

The latest `physical_count_post` migration also regressed schema assumptions:

- It queries `physical_count_lines.physical_count_id`, but the real column is `count_id`.
- It inserts `stock_adjustments` without required `organization_id` and `adjustment_number`.
- It references `stock_adjustments.source_physical_count_id`, which is not present in the current column set.
- It inserts `journal_entries` without required `organization_id` and `entry_number`.
- It inserts `journal_entry_lines` without required `organization_id`.
- It bypasses the existing `post_journal_entry_atomic` ledger helper.

Therefore fixing only the mapping key would expose the next broken assumption. The correct fix must restore the full event pipeline, not insert another mapping row.

## Architectural finding

There are currently duplicate accounting configuration surfaces:

1. **Legacy registry**: `default_accounts`
   - columns: `purpose`, `account_id`, `business_id`, optional branch support
   - consumed by legacy `resolve_default_account`
   - currently empty for this business
   - not what Settings → Account Mappings edits

2. **Canonical flat registry**: `default_account_settings`
   - columns: `setting_key`, `account_id`, `organization_id`, `business_id`, `branch_id`
   - edited by Settings → Account Mappings → Advanced Accounts
   - used by frontend hooks and several edge functions
   - validated by role/detail-type eligibility rules

3. **Canonical effective-dated registry**: `default_account_setting_bindings`
   - populated from `default_account_settings` by `trg_default_account_settings_binding_sync`
   - resolved by `resolve_default_account_binding`
   - already used by payroll posting as the enterprise-grade pattern

The enterprise-grade source should be:

```text
default_account_settings  -> current editable mapping surface
default_account_setting_bindings -> posting-time/effective-dated resolution surface
resolve_default_account_binding -> canonical runtime resolver
```

`default_accounts` is a legacy registry and should not be used by Inventory → Finance posting.

## Implementation plan

### 1. Replace physical count account resolution with the canonical resolver

Update `physical_count_post`, `physical_count_preflight`, and `physical_count_preview_je` to resolve accounts through:

```sql
public.resolve_default_account_binding(
  _setting_key := 'inventory',
  _org_id := v_c.organization_id,
  _business_id := v_c.business_id,
  _branch_id := v_c.branch_id,
  _as_of := now()
)
```

and:

```sql
public.resolve_default_account_binding(
  _setting_key := 'inventory_adjustment',
  _org_id := v_c.organization_id,
  _business_id := v_c.business_id,
  _branch_id := v_c.branch_id,
  _as_of := now()
)
```

No new mappings. No seed data. Use the rows that already exist.

### 2. Restore one shared physical-count posting pipeline

Rebuild `physical_count_post` so the event path is consistent:

```text
Physical Count approved
  -> validate warehouse / fiscal period / SoD
  -> resolve canonical GL mappings
  -> create stock adjustment with organization_id + adjustment_number
  -> create stock movement lines from count_id lines
  -> compute surplus/shrinkage from counted_qty, variance_qty, unit_cost_snapshot
  -> post balanced journal via post_journal_entry_atomic
  -> mark physical count posted
  -> write physical_count_events
  -> write business_event_outbox
```

### 3. Fix schema-column regressions

Use actual schema columns:

- `physical_count_lines.count_id`, not `physical_count_lines.physical_count_id`
- include `organization_id` on stock adjustments, journal entries, and journal lines
- include required `adjustment_number` and `entry_number`
- do not reference absent `source_physical_count_id`

### 4. Fix preview and preflight to use the same resolver as posting

- `physical_count_preflight` must report missing mappings using the exact same keys and resolver as `physical_count_post`.
- `physical_count_preview_je` must stop using `v_inv_row->>'code'` on a PL/pgSQL record; convert to JSON or use scalar fields.
- Preview, preflight, and post must agree on account IDs before the button is enabled.

### 5. Preserve enterprise accounting architecture

Do not make `Advanced Accounts` and `Default Accounts` separate authorities. Treat Advanced Accounts as a UI grouping inside the same default-account configuration surface.

Canonical rule:

```text
All module postings resolve GL mappings through default_account_setting_bindings.
default_account_settings is the editable current-state table.
default_accounts is legacy and must not be consumed by new Inventory posting.
```

### 6. Add regression guards

Add tests/guards to prevent recurrence:

- physical count posting must not reference `inventory_asset` as a canonical key.
- physical count posting must not read `default_accounts` or call legacy `resolve_default_account` for inventory postings.
- preflight, preview, and post must use the same mapping keys.
- physical count SQL must use `physical_count_lines.count_id`.
- journal posting must include organization/business/branch scope and be balanced/idempotent.

## Expected result after implementation

For PC-000005, posting should resolve:

```text
Inventory asset:
  key: inventory
  account: 1200 – Inventory
  source: default_account_setting_bindings / default_account_settings

Inventory adjustment:
  key: inventory_adjustment
  account: 5910 – Inventory Adjustments
  source: default_account_setting_bindings / default_account_settings
```

Then the ledger event should post approximately:

```text
DR 1200 – Inventory                  1,800
CR 5910 – Inventory Adjustments      1,800
```

for the current surplus line, with branch and business dimensions preserved.