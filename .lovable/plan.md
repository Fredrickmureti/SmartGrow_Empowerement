# Statements Forensic Audit — findings and remediation

## What actually happened

I pulled the real PDF bytes of the statement you saw (artifact
`606bc3c9…`, rendered 2026-08-10 04:20 UTC) out of storage and read them.
Confirmed: it is invoice-shaped — "Bill To", a `# / Description / Qty /
Price / Tax / Amount` table with no rows, "Amount Paid", "Balance Due",
"Thank you for your business!" — with only the title reading
"CUSTOMER STATEMENT". No ledger columns (Date / Type / Reference /
Charges / Credits / Running balance), no opening/closing balance, no aging.

Cause: the document was routed to the invoice renderer, not to the
statement renderer. That routing gate was corrected in this project at
04:27–04:31 UTC — **after** that artifact was produced at 04:20. So the
code in the repo is now right, but three things are still open, and the
audit surfaced two further defects that the routing fix does not touch.

## Confirmed defects

**1. The corrected renderer is not proven live, and bad artifacts are archived.**
The fix exists in the repo. The artifact you have is the pre-fix output, and
it is still the archived, downloadable copy of that statement. Every
statement artifact rendered before the fix is invoice-shaped and remains in
the document archive and version history.

**2. One statement click mints an A4 printer job as well as a download.**
The system output intent for `sales.statement` has exactly one target:
`pdf` / `download`. But the resolver also injects a *second*, policy-derived
target from the operator's print policy (role `fiscal_a4`, paper A4,
disposition `print`). Both jobs were created from the same click:

```text
click →  job A: disposition=print,    role=a4_printer  → failed  (render_failed)
         job B: disposition=download, transport=virtual → abandoned (stranded:
                  host print dialog owned the bytes)
```

So "Download PDF" reached a physical-printer role, and the download itself
was carried through the print queue and then closed as stranded. Download
and print are not cleanly separated for statements.

**3. Customer statements have no single dispatch exit; vendor statements do.**
Vendor statements funnel every surface through `dispatchVendorStatement`
(snapshot → document record → output intent). The customer side has no
equivalent: the page calls the export helper directly, so the two sides of
the same document class take different routes into the engine.

## What is architecturally sound (verified, no change needed)

- Source of truth is correct on both sides: customer statements fold
  `customer_ledger_entries`, vendor statements fold `vendor_ledger_entries`.
  Neither re-derives from invoices / payments / credit notes / bills.
- The statement renderer itself, once reached, produces a true ledger
  layout with no invoice fields.
- The download helper is disposition-correct in principle: it renders the
  frozen snapshot and hands bytes to the browser without touching hardware.

## Remediation

1. **Prove the renderer live.** Redeploy the rendering functions, re-render
   statement `91914727…`, and read the produced bytes back to confirm ledger
   columns and no invoice fields. Fix forward if anything remains.
2. **Quarantine the bad artifacts.** Mark pre-fix statement artifacts as
   superseded so no surface (download, email, archive, version history)
   serves an invoice-shaped statement again.
3. **Separate print from download for statements.** A financial statement
   must not acquire a physical print target from a transactional-document
   print policy on a download action. The resolver stops injecting a
   policy-derived `print` target for statement kinds, and a download
   disposition stops being carried through the host print dialog.
4. **Give customer statements one dispatch exit.** Add
   `dispatchCustomerStatement`, mirroring the vendor module, and point every
   customer-statement surface (list action, peek sheet, record page) at it.
5. **Freeze the regressions.** Extend the existing routing guard so a
   statement kind can never resolve an invoice template profile, and add a
   guard that no statement kind can produce a `print`-disposition job from a
   download action.

## Technical notes

- Invoice-shaped bytes confirmed by extracting text from
  `document-artifacts/…/sales.statement/91914727…/606bc3c9….pdf`.
- Routing gate: `supabase/functions/_shared/rendering/renderers/pdf.ts`
  (`renderAstToPdf`, registered for the `pdf` medium in `mediumRegistry.ts`).
  Legacy `generate-document` still maps `customer_statement` /
  `vendor_statement` to the `invoice` template type — that mapping is audited
  and removed as part of step 5.
- Dual-target fanout: `public.resolve_output_intent` builds
  `v_policy_target` from `document_print_policies` and prepends it to the
  intent's own targets; `public.submit_document_intent` then writes one
  `print_jobs` row per target. Statement kinds need to opt out of the
  policy-derived print target.
- Download-through-print-queue: the `download` target is dispatched on the
  `virtual` transport and closed by `src/services/printing/recovery.ts` as
  `stranded` when the host dialog owns the bytes.
- Both fixes to `resolve_output_intent` and artifact supersession are
  migrations; the dispatch exit and guards are application code.
