# Vendor Credit Notes — Authoritative Project Status

Domain: Purchases / AP vendor credit notes (physical + financial credits).
Roadmap source: `.lovable/plan/vendor-credit-note-architecture-audit-and-rebuild-2026-08-12.md`
and `.lovable/plan/vendor-credit-notes-verification-result-and-phase-5-plan-2026-08-12.md`.

## Current phase

**Phase 5 — Document Identity, Lifecycle Events & Action Parity: IMPLEMENTED, awaiting independent verification.**

## Fully implemented (this phase)

Database (migration applied):
- `document_kinds` now carries `purchases.credit_note`, with a seeded system-default AST layout.
- `vendor_credit_notes.commercial_status` gained `disputed`, plus `disputed_at`, `dispute_reason`,
  `dispute_resolved_at`, `dispute_resolution` tracking columns.
- Server-authoritative RPCs `vendor_credit_note_dispute` and `vendor_credit_note_resolve_dispute`.
- Event topic `purchases.vendor_credit_note.*` registered in `business_event_topics`.
- `_emit_vcn_outbox()` + trigger `tg_vcn_emit_lifecycle` emit durable outbox events with deterministic
  idempotency keys for: created, submitted, approved, rejected, disputed, cancelled, posted, applied, reversed.

Client / edge:
- `src/services/documents/snapshots/purchasesVendorCreditNote.ts` — frozen snapshot builder
  (header, lines, totals, Bill and Purchase Return provenance).
- Registered in `src/services/documents/resolveSourceDocumentRecord.ts` under `vendor_credit_note`.
- Shared Print (`useRecordPrint.tsx`) and Download (`useRecordDownload.ts`) kinds added.
- `SendDocumentDialog` `DocumentType` union + label extended with `vendor_credit_note`.
- `send-document-email` edge function: `vendor_credit_note` table config (no `statusField` — lifecycle is
  server-owned), label, and vendor contact join; canonical-artifact path used, no legacy live re-read.
- Email action freezes the snapshot via `resolveSourceDocumentRecordId` before opening the dialog, so the
  mailer always has an archived artifact to attach.
- `useVendorCreditNotes.ts` exposes `disputeVendorCreditNote` / `resolveVendorCreditNoteDispute`.
- `useVendorCreditNoteActions.tsx`: `window.prompt` removed — reject / cancel / dispute now use structured
  AlertDialog reason capture; new `output` action group (Preview, Email, Print, Download).
- `VendorCreditNoteRecordPage.tsx` renders the action dialogs.
- `documentStatus.tsx` has a `disputed` tone.

Verified: full TypeScript typecheck passes with no errors.

## Pending / not yet done

- CI architecture ratchets asserting document-kind + outbox-event parity for every new lifecycle command
  (planned in Phase 5, not yet written).
- Runtime end-to-end proof: create → submit → approve → post → apply → reverse, checking one outbox row per
  transition and one `document_artifacts` row per emailed/printed credit note.
- Dispute states are not yet surfaced in list filters / analytics tiles.
- Purchase Return → Credit Note lineage is captured in the snapshot but not yet shown as a linked-records
  panel on the record page.

## Next agent — start here

1. **Verify before building.** Confirm Phase 5 is enterprise-grade:
   - Query `document_kinds`, `business_event_topics`, and the `tg_vcn_emit_lifecycle` trigger definition.
   - Exercise the lifecycle on a scratch credit note and assert exactly one `business_event_outbox` row per
     transition, with stable idempotency keys (re-run must not duplicate).
   - Print/Download/Email one credit note and confirm a `document_records` + `document_artifacts` pair exists
     and that no `generate-document` legacy fallback was hit (check edge logs).
   - Confirm no client-side financial math and no direct table writes remain in the credit-note feature.
2. **Then resume chronologically** with the remaining Phase 5 items above (CI ratchets first), and only after
   they are closed move to Phase 6 in the rebuild plan.
3. Do not open unrelated domains; keep each phase production-ready before advancing.
