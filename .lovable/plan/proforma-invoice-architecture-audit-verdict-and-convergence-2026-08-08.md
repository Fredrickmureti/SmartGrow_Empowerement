# Proforma Invoice — Architecture Audit Verdict and Convergence Plan

## 1. Executive verdict

The Proforma domain is **architecturally sound at its most dangerous boundaries and does not need a rewrite**. It is not a renamed Estimate, and it is not an invoice clone. Where it is wrong, it is wrong in the *governance and numbering* layer, not the accounting layer.

Correct and must not be touched:
- **Accounting-safe.** No trigger, RPC or client path on `proforma_invoices` writes journal entries, AR, revenue, tax liability, customer balances or accounting events. Live DB check: the only triggers on the table are `enforce_org_write_lock`, `validate_branch_business_match`, `update_updated_at_column`. Conversion creates a **draft** invoice; posting happens later through the invoice's own confirmation path.
- **Inventory-safe.** No stock movement, reservation or warehouse effect anywhere in the proforma path.
- **Payment-safe.** There is no way to pay a proforma. Settlement UI is invoice-only by design (`DocumentSettlementStrip` is gated to `docType === "invoice"`). Customer money before invoicing already has a canonical home (`record_advance_payment`). This matches enterprise practice — a proforma is not a demand for payment.
- **Conversion is atomic, idempotent and traceable.** `convert_proforma_to_invoice_atomic` takes `FOR UPDATE`, refuses when `converted_invoice_id IS NOT NULL`, checks business access, copies header+lines, stamps `invoices.source_proforma_invoice_id`, and flips the proforma to `converted` in one transaction. A cross-business trigger guards the link.
- **Document architecture compliant.** Printing goes through `ensureDocumentRecord` → `sales.proforma` snapshot → `document_records`, registered in `resolveSourceDocumentRecord`. No second PDF engine. Leave it alone.
- **Read scoping correct.** Org + business + `applyBranchFilter` on list reads; branch/business match trigger on write.

Proven defects (all governance/integrity, none accounting):
1. **Numbering is a generation behind and unsafe.** `get_next_proforma_number(_org_id)` does `MAX(digits)+1` scoped by organization only, with no advisory lock, and there is **no unique constraint on `proforma_number`**. Invoices were hardened to `pg_advisory_xact_lock` + business scope + per-business prefix; proforma never was. Two concurrent creates, or two businesses in one org, can produce duplicate proforma numbers on an externally-issued document.
2. **Item-level RLS is weaker than the header.** Header policies use `user_has_module_permission(..., 'sales', ...)`; `proforma_invoice_items` still carries the original org-membership `FOR ALL` policy, so a user without sales permissions can alter the lines of any proforma in the org. Header policies also never got the business-aware upgrade its siblings received.
3. **Create is not atomic and totals are client-computed.** The hook inserts the header, then the lines, in two calls — a failed second insert leaves a header with no lines. Subtotal/tax/total are computed in the create page and stored verbatim with no server recomputation.
4. **No lifecycle state machine and no audit trail.** Status is a plain `UPDATE ... SET status`. Estimates route every transition through `set_estimate_status_atomic`, enforced by a trigger, and log every mutation via `useAuditLog`. Proforma emits **zero** audit or outbox events for issue, convert, cancel or delete. An issued proforma is fully editable, including after conversion.
5. **Status vocabulary is incoherent.** The CHECK allows `draft/sent/accepted/rejected/expired/converted`; the converter additionally tests for `viewed`/`approved`, which can never exist. Nothing ever writes `accepted`, `rejected` or `expired` — there is no expiry job despite `expiry_date` being mandatory. There is no cancellation state.
6. **Provenance can be destroyed.** Delete is permitted at any status, including `converted`; `invoices.source_proforma_invoice_id` is `ON DELETE SET NULL`, so deleting a converted proforma silently erases the lineage the audit trail depends on.
7. **UI row actions (send, convert, delete) have no permission gate** — only a subscription read-only check. RLS backstops the header but not, per defect 2, the lines.

Verdict: **converge Proforma onto the canonical Sales patterns that already exist. Introduce nothing new.**

## 2. Business definition used

A Proforma Invoice in this ERP is a **binding-looking but non-accounting commercial declaration of what an invoice will say** — issued for advance-payment requests, customs/import documentation, and buyer-side purchase approval. It carries invoice-grade detail (prices, taxes, totals, terms) but creates no receivable, no revenue, no tax liability, and no stock commitment. It becomes economically real only when converted into an Invoice.

Distinction from neighbours, as this codebase actually implements them: Estimate/Quotation = negotiable offer, pipeline; Sales Order = operational commitment, reserves stock; **Proforma = payment/customs instrument, no commitment**; Invoice = the accounting event (AR + revenue + tax); Delivery Note = the inventory event (COGS); Receipt/Payment = cash; Credit Note = reversal of an invoice; Customer Deposit/Advance = cash held before an invoice exists, already handled by `record_advance_payment`, which is why paying a proforma directly is correctly absent.

## 3. Changes to make

**A. Numbering convergence (migration)**
- Rewrite `get_next_proforma_number` to `(_org_id, _business_id)`: require business, take `pg_advisory_xact_lock(hashtext('proforma_' || business_id))`, scope `MAX()` by org + business, use the business's configured prefix with a `PI-` fallback. Keep the old 1-arg signature as a thin wrapper only if a caller remains.
- Add `UNIQUE (organization_id, business_id, proforma_number)`.

**B. Security convergence (migration)**
- Replace the `proforma_invoice_items` org-membership `FOR ALL` policy with per-command policies mirroring the header (`user_has_module_permission(..., 'sales', read/create/write/delete)`), plus the subscription write gate.
- Bring header policies to the business-aware form used by `estimates`/`delivery_notes`.
- Add the missing explicit `GRANT`s for `authenticated`/`service_role` on both tables.

**C. Lifecycle state machine (migration)**
- Add `set_proforma_status_atomic(p_id, p_status, p_user_id)` modelled directly on `set_estimate_status_atomic`: validates the transition (`draft→sent`, `sent→accepted|rejected|expired`, `→cancelled`, `*→converted` only via the converter), refuses any change once `converted_invoice_id IS NOT NULL`, and writes an audit row.
- Add a `BEFORE UPDATE` trigger rejecting direct `status` writes outside that RPC and the converter — the same enforcement Estimates already have.
- Add `cancelled` to the status CHECK; drop `viewed`/`approved` from the converter's guard so the guard and the schema agree.
- Add a `BEFORE UPDATE` guard freezing financial fields (totals, lines, contact, number) once status is `converted`, and a `BEFORE DELETE` guard refusing deletion of a converted proforma so lineage survives.
- Emit `audit_logs` rows for issue, cancel, convert and delete.

**D. Atomic create (migration + hook)**
- Add `create_proforma_atomic(p_header jsonb, p_items jsonb)` that allocates the number, inserts header and lines in one transaction, and **recomputes** subtotal/tax/total from the lines server-side rather than trusting the client.
- Point `useProformaInvoices.createProformaInvoice` at it; delete the two-step client insert and the client-side numbering call.

**E. Frontend convergence (no new UI)**
- `useProformaInvoices`: add `can("manageSales")` gates and `useAuditLog` calls on every mutation, matching `useEstimates`; route status changes through `setProformaStatus` and strip `status` from `updateProformaInvoice`.
- Wrap the list-row Send / Convert / Delete actions in `PermissionGate permission="manageSales"`.
- Hide Delete and Edit for `converted` proformas.
- Reuse the shared totals helper pattern instead of the inline arithmetic in `ProformaCreatePage`.
- Fix the stale header comment in `ProformaRecordPage`.

**F. Expiry**
- Extend the existing scheduled sales job to flip `sent` proformas past `expiry_date` to `expired` through the new RPC, so `expiry_date` stops being decorative.

**G. Verification**
- Tests: numbering concurrency + uniqueness; double-convert rejection; direct-status-write rejection; converted-proforma edit/delete rejection; server-side totals recomputation; an architecture test asserting no accounting/inventory identifier ever appears in a proforma-reachable function.
- Record the audit as `docs/audit/proforma-domain-verdict.md` and add the Proforma row to `docs/sales-audit.md`.

## 4. Explicitly not doing

No AR, GL, tax-liability or inventory behaviour is added. No payment-against-proforma feature. No second PDF or preview path. No new numbering engine — the invoice engine's pattern is reused. No country-specific behaviour; tax stays snapshot-carried and localization-driven, recalculated by the invoice on confirmation. No renaming or merging of Proforma into Estimates.

## 5. Regression risk

The status trigger (C) is the highest-risk item: any existing writer of `proforma_invoices.status` that is not routed through the new RPC will start failing. Mitigation: the only writers found are `useProformaInvoices.updateProformaInvoice`, the list page's Send action, and the converter — all three are updated in the same change, and the converter is granted an explicit bypass. The numbering change requires a business context on create, which the create path already supplies. Reads, printing, snapshots and conversion payloads are untouched.
