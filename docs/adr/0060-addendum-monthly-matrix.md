# ADR-0060 Addendum — Monthly Matrix Dataset & Payload Contract

**Status:** Accepted
**Depth:** Refinement of ADR-0060 (block-primitive certificate renderer).
**Applies to:** All country localization packs producing statutory tax
certificates (Kenya P9/P9A, plus every future country pack).

## Context

ADR-0060 introduced a block-primitive renderer (`certificateRendererV2`)
that reads a `body.blocks[]` AST and knows nothing about any specific
country's form. The renderer supports `heading`, `paragraph`,
`field_grid`, `table`, `notes`, `divider`, `spacer`, `image`, and
`signature_block`.

Once we moved Kenya P9 to the block AST we discovered two gaps:

1. **The default table data source (`monthly_breakdown`) is a normalized
   rule-code stream.** Row shape is
   `{ month_index, rule_code, employee_amount, employer_amount, taxable_amount }`.
   That's the right primitive for the platform (country-agnostic), but
   it forces every template to know rule codes and forces the renderer
   to aggregate by rule-code equality. Computed columns
   (KRA E1 = 30 % of A, K = D − J, O = L − M − N) had no representation
   at all — those aren't rule codes and never will be.

2. **Employee/employer field-grid keys were undocumented.** Templates
   silently rendered blanks whenever the generator's payload didn't
   happen to expose the key the pack expected.

This addendum resolves both without changing the block AST or the
renderer's public surface.

## Decision

### 1. `monthly_matrix` — a semantic 12-row dataset

Add a new resolver that pivots the rule-code stream into a 12-row
matrix keyed by rule_code (one column per requested key, seeded to
zero) and applies pack-authored **derived columns** via a tiny
expression DSL evaluated on each row.

```
DerivedColumn = {
  key:  string
  expr: "sum" | "sub" | "min" | "max" | "pct"
  args: Array<string | number>   // column key or numeric literal
}
```

Semantics:

- `sum(a,b,c,…)`  = a + b + c + …
- `sub(a,b,c,…)`  = a − b − c − …
- `min(a,b,…)`    = Math.min(…)
- `max(a,b,…)`    = Math.max(…)
- `pct(a, r)`     = a * r

Args are either matrix column keys (looked up per-row) or numeric
literals. Unknown keys resolve to `0`. Order of `derived_columns[]`
matters — later expressions may reference earlier derived keys.

TableBlock authoring:

```json
{
  "type": "table",
  "data_source": "monthly_matrix",
  "group_by": "month_index",
  "amount_field": "employee_amount",
  "columns": [
    { "key": "month_index",       "header": "Month",           "format": "text",     "width": 30 },
    { "key": "basic_salary",      "header": "A · Basic",       "format": "currency", "width": "1fr" },
    { "key": "chargeable_pay",    "header": "K · Chargeable",  "format": "currency", "width": "1fr" }
  ],
  "derived_columns": [
    { "key": "chargeable_pay", "expr": "sub", "args": ["gross_pay", "total_relief_deductions"] }
  ]
}
```

The renderer path is:

```
raw monthly rows (rule_code stream)
  → pivotToMonthlyMatrix(rows, columnKeys, amount_field)   // one row per month, columns seeded to 0
  → applyDerivedColumns(rows, derived_columns)             // in-order DSL evaluation
  → table cells
```

`monthly_breakdown` is retained unchanged for country packs that
already project a small column set and want the aggregation-by-rule-code
behaviour. Both resolvers coexist; templates pick the one they need.

### 2. Payload contract for `payload.employee` / `payload.employer`

`generate-tax-certificate` guarantees the following keys on every
certificate payload, resolved to `""` when the source data does not
carry them (never `null` or `undefined`):

**`payload.employee`**

```
id, full_name, employee_number, tax_pin, national_id,
position, department, hire_date, termination_date
```

**`payload.employer`**

```
name, tax_pin, address, tax_office, phone, email
```

`FieldGrid` uses `.filter(val.trim())` after formatting, so any key not
supplied by the source is elided cleanly. Templates may bind to any of
these keys and rely on the field vanishing gracefully when the data
isn't present — no more silent blank cells with the label visible.

### 3. `body.page.orientation` is template-owned

Already implemented in `computeLayoutV2` and exposed via the template
editor's Page Orientation control. This addendum only clarifies that
wide tables (KRA A–O, IRP5, W-2, etc.) MUST declare landscape
themselves — the renderer does not auto-detect.

## Consequences

- Country packs can express arbitrary regulatory math (30 % rules,
  statutory caps, PAYE net formulas) without any platform code
  changes.
- The renderer stays country-agnostic. Only two new resolver names
  (`monthly_matrix`) and one new TableBlock property
  (`derived_columns` + `amount_field`) enter its public surface.
- The Kenya localization pack ships as **v10.0.0** with the KRA P9/P9A
  rewritten as `monthly_matrix` tables carrying the E1/E3/J/K/O
  formulas inside the pack body. Future country packs (RSA IRP5,
  Nigeria PAYE, Ghana income tax) can follow the same recipe.
