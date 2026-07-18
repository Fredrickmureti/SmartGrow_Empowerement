# Procurement Domain — Authoritative Project Status

**Last updated:** 2026-07-18
**Current phase:** Phase H+ (Hardening & Architecture Audit) — active
**Next milestone:** Batch I-Deferred (Vendor Credit Note FIFO allocation)

> This file is the single source of truth for procurement-domain progress. Every claim below is backed by evidence gathered via `supabase--read_query` on the live schema, `rg` over `src/`, or a linked commit / doc. Nothing in this file may assert current state without a verifying read.

---

## 1. Status dashboard

### 1.1 Feature build phase — **CLOSED**

| Batch | Scope | Status | Evidence |
| --- | --- | --- | --- |
| A | `suppliers` master + categories + qualifications | ✅ Landed & verified | `information_schema` — `suppliers`, `supplier_categories`, `supplier_qualifications`, `supplier_qualification_documents` present |
| B | `supplier_item_terms`, `vendor_pricelists`, `approved_supplier_list` | ✅ Landed & verified | tables present |
| C | RFQ / sourcing (`rfqs`, `rfq_vendors`, `rfq_items`, `sourcing_events`, scoring) | ✅ Landed & verified | tables present |
| D | Procurement contracts (`procurement_contracts`, lines, releases) | ✅ Landed & verified | tables present |
| E | Purchase requisitions + PO approval RPC (`approve_purchase_order`) | ✅ Landed & verified | `pg_proc` — SECURITY DEFINER, search_path=public |
| F | ASN (`inbound_shipments` + `receive_inbound_shipment` RPC) | ✅ Landed & verified | `pg_proc` |
| G | GRN (`goods_receipts` + `create_goods_receipt` RPC + discrepancies) | ✅ Landed & verified | `pg_proc` |
| H | 3/4-way match (`bill_match_tolerance_policies`, `bill_match_results`, `bill_match_exceptions`, `match_bill_atomic`, `match_bill_with_landed_cost`) | ✅ Landed & verified | `pg_proc` + tables |
| H-Verify | Rollback-marker smoke: idempotency, over/under-billing, price variance, 4-way landed uplift, SoD self-approval | ✅ Landed & verified | execution log below |

### 1.2 Hardening phase (Phase H+) — **ACTIVE**

| Sub-phase | Scope | Status |
| --- | --- | --- |
| Phase 0 | Rewrite plan to reflect milestone | ✅ Done (this file) |
| Phase 1 | Independent verification of feature-phase claims (read-only) | ✅ Done — see §3 |
| Phase 2 | Publish Contact ↔ Supplier ↔ Vendor architecture audit | ✅ Done — `docs/audit/procurement-vendor-vs-supplier.md` |
| Phase 3 | Small hardening batches | ⏳ Partial — H+1 / H+2 / H+3 / H+4 landed; no more identified |
| Phase 4 | Legacy `/purchases/vendors` retirement strategy (planning only) | ✅ Done — documented in audit §2.3 + queued as Batch K-Retire |
| Phase 5 | Playwright + RLS re-audit (Batch L + Batch M) | ⏸ Queued — not started |
| Phase 6 | Repair queue (contingent on Phase 1 FAILs) | ⏳ 1 FAIL open — Batch I never landed; re-queued as I-Deferred |

### 1.3 Confirmed gaps still to close (in execution order)

| # | Item | Blocker for | Owner batch |
| --- | --- | --- | --- |
| G1 | `apply_vendor_credit_note_atomic` RPC missing from `pg_proc` | Vendor credit note lifecycle (returns → credit → allocation → JE) | **Batch I-Deferred** (next milestone) |
| G2 | `governance_duties.credit.approve` and `credit.apply` missing | Cannot register SoD conflicts for credit workflow | Batch I-Deferred (same migration) |
| G3 | Supplier record page lacks a "Finance defaults" section (AP account, WHT, tax id) | Prevents retirement of `/purchases/vendors` UI | Batch K-Retire (blocked on G1) |
| G4 | Contact custom-field slot not rendered on Supplier record page | Same as G3 | Batch K-Retire |
| G5 | No Playwright coverage for: currency inheritance, bill self-approval guard regression, `/vendors` still-rendering guard | Regression risk on H+1/H+2 + H-Verify fix | Batch L (queued after K-Retire) |
| G6 | Consolidated verdict doc not published | Closes hardening phase | Batch M (queued last) |

---

## 2. Roadmap — chronological, do NOT reorder

Each item is brought to production-ready state before the next begins.

1. ✅ **Batches A → H** — feature build (closed).
2. ✅ **Batch H-Verify** — matching smoke.
3. ✅ **Phase 1 verification** — read-only audit of feature claims.
4. ✅ **Phase 2 audit doc** — `docs/audit/procurement-vendor-vs-supplier.md` + ADR-0079.
5. ✅ **H+1** — Supplier currency defaults from `businesses.base_currency`.
6. ✅ **H+2** — Legacy nav label clarified ("Suppliers (contact view)").
7. ✅ **H+3** — ADR-0079 (Party vs Role dual-key model).
8. ✅ **H+4** — Studio field inventory (0 configs on `supplier` today; recorded).
9. ⏭ **Batch I-Deferred — NEXT MILESTONE.** Vendor credit note FIFO. Single migration + RPC + governance duties + SoD conflicts + rollback-marker smoke. Emits `procurement.credit.applied` outbox. Must not touch `journal_entries` (Finance subscribes via outbox).
10. ⏸ **Batch K-Retire** — Migrate AP-defaults editor + Contact custom-field slot onto Supplier record page; only THEN retire `/purchases/vendors` route. Blocked on G3/G4.
11. ⏸ **Batch L** — Playwright: H+1 currency default, H-Verify self-approval guard, K-Retire route removal, I-Deferred credit lifecycle happy path.
12. ⏸ **Batch M** — `docs/audit/procurement-verdict.md` consolidated close-out; flip Phase H+ to CLOSED.

**Do not skip ahead.** Do not open unrelated procurement work (e.g. Sourcing 2.0, Supplier Portal enhancements, WMS crossovers) until Batch M closes.

---

## 3. Phase 1 verification log (evidence)

| # | Item | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Canonical RPCs present + `SECURITY DEFINER` + `search_path=public` (`approve_purchase_order`, `receive_inbound_shipment`, `create_goods_receipt`, `match_bill_atomic`, `match_bill_with_landed_cost`) | PASS | `pg_proc` query |
| 1a | `apply_vendor_credit_note_atomic` | **FAIL** → G1 | Absent from `pg_proc` |
| 2 | Governance duties (`asn.manage`, `bill.approve`, `bill.match`, `grn.receive`, `po.approve`, `supplier_terms.manage`) | PASS | 6 rows in `governance_duties` |
| 2a | `credit.approve`, `credit.apply` duties | **FAIL** → G2 | Missing |
| 3 | SoD conflicts registered | PASS | 43 rows in `governance_sod_conflicts` including bill.match ↔ po.approve / grn.receive / asn.manage |
| 4 | `guard_bill_self_approval` enum→text cast fix in place | PASS | `pg_proc.prosrc LIKE '%::text%'` |
| 5 | Every procurement document keys off `contacts.id` (no `supplier_id` FKs) | PASS | `information_schema.columns` |
| 6 | Studio `entity_field_configs` inventory | PASS | 1 `contact`, 1 `estimate`, 0 `supplier` |
| 7 | RLS `business_id` predicate on P1–H tables + branch-scoped policy check | PASS (carried forward from Batch H-Verify; not re-run this turn) | `v_branch_scoped_policy_check` |

---

## 4. Files changed during Phase H+

| Path | Change | Batch |
| --- | --- | --- |
| `docs/adr/0079-procurement-party-vs-role.md` | New — locks dual-key model | H+3 |
| `docs/audit/procurement-vendor-vs-supplier.md` | New — evidence-backed audit | Phase 2 |
| `src/features/purchases/suppliers/SupplierCreatePage.tsx` | `useEffect` seeds `currency` from `currentBusiness.base_currency` | H+1 |
| `src/apps/purchases/nav.ts` | Label "Vendors (legacy)" → "Suppliers (contact view)" | H+2 |
| `.lovable/plan.md` | Rewritten as authoritative status dashboard | Phase 0 |

No migrations landed in Phase H+ so far — all frontend + docs. The next migration is Batch I-Deferred.

---

## 5. Instructions for the next agent

**Before writing any code, verify the previous work is correct and enterprise-grade.**

1. **Confirm the status dashboard (§1) is still accurate.** Run these queries and reconcile with §1.1 / §1.2 / §3:
   - `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('approve_purchase_order','receive_inbound_shipment','create_goods_receipt','match_bill_atomic','match_bill_with_landed_cost','apply_vendor_credit_note_atomic');`
   - `SELECT code FROM governance_duties WHERE code LIKE 'credit.%' OR code IN ('po.approve','asn.manage','grn.receive','bill.approve','bill.match','supplier_terms.manage');`
   - `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('vendor_id','supplier_id') AND table_name IN ('purchase_orders','bills','rfq_vendors','purchase_returns','vendor_credit_notes');`
2. **Confirm H+1 code fix survived.** `rg "currentBusiness\.base_currency" src/features/purchases/suppliers/SupplierCreatePage.tsx` must return a match inside a `useEffect`.
3. **Read the audit + ADR** before touching any procurement code: `docs/audit/procurement-vendor-vs-supplier.md` and `docs/adr/0079-procurement-party-vs-role.md`. If your change would add a `supplier_id` FK to any transactional document, **stop** — that is explicitly forbidden by ADR-0079.
4. **Then, and only then, start Batch I-Deferred (§2 item 9).** Do NOT jump to Batch K-Retire, Batch L, or unrelated procurement work. Batch I is a hard prerequisite for K-Retire's Finance-defaults editor (which will surface credit-note history), and the roadmap is strictly chronological.

**Batch I-Deferred contract:**
- Single migration file.
- Add `governance_duties`: `credit.approve`, `credit.apply`.
- Add SoD conflicts: `credit.approve` ↔ `bill.approve`, `credit.apply` ↔ `credit.approve`, `credit.apply` ↔ `bill.match`.
- Create `apply_vendor_credit_note_atomic(p_credit_note_id uuid, p_bill_ids uuid[])` RPC:
  - `SECURITY DEFINER`, `SET search_path = public`.
  - FIFO allocation against `bills.balance_due` in `due_date ASC, created_at ASC` order.
  - Writes to `vendor_credit_note_applications`; updates `vendor_credit_notes.status` and `bills.balance_due` / `bills.status`.
  - Emits `procurement.credit.applied` to `business_event_outbox` with idempotency key `credit.applied:<credit_note_id>:<version>`.
  - **Must not** insert into `journal_entries`, `journal_entry_lines`, `stock_movements`, or `cost_layers`. Finance subscribes to the outbox and posts the reversal JE. Extend `src/test/architecture/procurement.test.ts` writer allow-list accordingly.
- Rollback-marker smoke migration: create a credit note, apply against 2 bills, assert FIFO order, assert idempotency (re-apply is a no-op), assert SoD blocks the credit-approver from applying, assert `__SMOKE_ROLLBACK_MARKER__` present.
- Update this file's §1.2 and §1.3 rows once landed.

**After Batch I-Deferred lands and is verified, proceed to Batch K-Retire (§2 item 10) — not before.**

**Pre-existing project-wide TS errors** (`Cannot find module 'react-router-dom' | 'framer-motion' | 'idb' | 'qrcode.react'`) are a stale typecheck artifact — all four packages are present in `package.json`. They are **not** caused by this phase's edits and should not be "fixed" by reinstalling or editing types unless the user explicitly asks.
