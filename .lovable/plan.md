# Barcode edit on phone saves only one character

## What you saw is a real defect, not human error

I checked the live data for the product you edited. The stored identifier is literally:

```text
code = "1"   kind = gtin   source = manual
created 16:50:33   updated 16:57:32
```

So the row was created earlier and then **overwritten with a single character** by a later edit. The database write function is not at fault — it stores whatever code the app hands it, and it received `"1"`.

## Confirmed cause (structural) and the part still to confirm

Confirmed by reading the editor code: `ProductIdentifiersEditor.updateRow` fires a **network save on every single keystroke / value change**, with no ordering guard:

```text
onChange("2")  -> RPC save
onChange("23") -> RPC save
...            -> RPC save
```

For an already-saved row these RPCs run concurrently and **whichever finishes last wins**. On a phone (slower, higher-latency network, camera overlay re-rendering the controlled input) an intermediate one-character value can be the last write to land — which is exactly the `"1"` now in the database. The field keeps showing the full code because local state is correct; only the persisted value is wrong.

Not yet proven: the precise sequence that leaves `"1"` specifically rather than another fragment. I will reproduce it first with an instrumented run before changing behaviour, so the fix is aimed at the real path.

## Plan

1. **Reproduce with instrumentation.** Drive the product edit screen in a mobile viewport, log every value handed to the write seam and the completion order of the saves, and confirm the last-write-wins race produces a truncated code.

2. **Stop saving on every keystroke.** The identifier row persists on:
   - a confirmed scan (full decoded code, immediate), and
   - field blur / form save,
   
   never on each character typed.

3. **Add a write-ordering guard per row.** Each row keeps a sequence number; a save whose sequence is older than the newest issued for that row is discarded when it returns, so a stale in-flight save can never overwrite a newer code. Only one save per row is in flight at a time; the newest pending value is written when it settles.

4. **Save the live value, not a snapshot.** `updateRow` currently merges into a render-time snapshot of the rows. It will read from a ref holding current row state, so a partial-field save can't resurrect an older code either.

5. **Repair the damaged record.** Restore the affected product's barcode to the full scanned code (the archived SKU mirror stays as-is), and check for any other identifiers that look truncated from the same race.

6. **Regression test.** A test that issues a rapid sequence of value changes and out-of-order save completions and asserts the persisted code equals the final full code — this is the guard that keeps the race from returning.

## Technical notes

- Files: `src/components/products/ProductIdentifiersEditor.tsx` (write scheduling, sequence guard, ref-backed rows), test under `src/test/inventory/`.
- No database schema or RPC change: `upsert_product_identifier` already behaves correctly.
- The scan paths (in-app camera, paired phone, USB wedge) all deliver a complete code through the same target, so they keep saving immediately — only the per-character typing path changes.
